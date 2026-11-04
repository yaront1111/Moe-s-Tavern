'use strict';

// VSC-15: the Accounts view actions (add, sign in, remove, move up/down, rename, switch percent), the VS Code side of
// JetBrains AccountsPanel. Enablement is VSC-13's AccountPresentation.actions over the shared accounts corpus, every
// dialog text is MoeBundle.properties English, and sign-in runs the daemon's accounts CLI in a terminal. The corpus and
// the bundle are read here, never edited. The provider loads with VSC-14's closed require map (vscode, AccountPresentation).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const files = {
    corpus: path.join(root, '../moe-jetbrains/src/test/resources/client-accounts.json'),
    bundle: path.join(root, '../moe-jetbrains/src/main/resources/messages/MoeBundle.properties'),
    presentation: path.join(root, 'src/util/AccountPresentation.ts'),
    provider: path.join(root, 'src/providers/AccountsTreeProvider.ts'),
    launcher: path.join(root, 'src/util/AgentLauncher.ts'),
    extension: path.join(root, 'src/extension.ts'),
    manifest: path.join(root, 'package.json')
};

function read(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        throw new Error(`cannot read ${file}: ${error.message}`);
    }
}

function readJson(file) {
    try {
        return JSON.parse(read(file));
    } catch (error) {
        throw new Error(`${file} is not valid JSON: ${error.message}`);
    }
}

function load(file, requireFn) {
    const module = { exports: {} };
    const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInThisContext(`(function (exports, module, require) {${code}\n})`, { filename: file })(module.exports, module, requireFn);
    return module.exports;
}

// A properties value decodes `\n` to a newline (moe.accounts.terminal.unavailable has one).
const bundle = new Map([...read(files.bundle).matchAll(/^(moe\.[A-Za-z.]+)=(.*?)\r?$/gm)].map(m => [m[1], m[2].replace(/\\n/g, '\n')]));
const t = (key, ...args) => {
    assert.ok(bundle.has(key), `${key} is missing from ${files.bundle}`);
    return bundle.get(key).replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)]));
};
const corpus = readJson(files.corpus);
const rowOf = id => {
    const found = corpus.rows.find(r => r.id === id);
    assert.ok(found, `corpus row ${id} is missing`);
    return found;
};
const clock = { now: () => Date.parse(corpus.now), zone: () => corpus.zone };
const NOT_CONNECTED = 'Not connected to Moe daemon \u2014 the account change was not sent.';
const LABEL_HINT = 'Use at most 64 characters and no control characters.';
const PERCENT_HINT = 'Enter a whole number from 1 to 100.';
const NAMES = ['add', 'signIn', 'remove', 'moveUp', 'moveDown', 'rename', 'setSwitchPercent'];
const COMMANDS = NAMES.map(name => `moe.accounts.${name}`);
/** Row menu token -> the AccountPresentation.actions flag that enables it. */
const TOKENS = { canSignIn: a => a.signIn, canRename: a => a.rename, canMoveUp: a => a.moveUp, canMoveDown: a => a.moveDown, canRemove: a => a.removeOnly || a.signOutAndRemove };
const expected = flags => Object.keys(TOKENS).filter(token => TOKENS[token](flags)).sort();
const tokens = contextValue => {
    assert.equal(contextValue.split(' ')[0], 'moe.account');
    return contextValue.split(' ').slice(1).sort();
};

class Emitter {
    constructor() {
        this.listeners = new Set();
        this.event = listener => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; };
    }
    fire(value) { for (const listener of [...this.listeners]) listener(value); }
    dispose() { this.listeners.clear(); }
}

const presentation = load(files.presentation, name => { throw new Error(`AccountPresentation.ts must not require ${name}`); });

/**
 * A provider with recording fakes. `answers` feeds showInputBox and the modal confirm in order (a function answer runs
 * while the dialog is open and returns the answer); `result` is every sender's return.
 */
function setup(rotation = rowOf('C05').rotation, { connected = true, register = true } = {}) {
    const rec = { answers: [], inputs: [], warnings: [], errors: [], terminals: [], clipboard: [], context: new Map(), commands: new Map(), sends: [], result: true, noTerminal: false };
    const answer = () => { const next = rec.answers.shift(); return typeof next === 'function' ? next() : next; };
    const vscode = {
        EventEmitter: Emitter,
        TreeItem: class { constructor(label) { this.label = label; } },
        TreeItemCollapsibleState: { None: 0 },
        window: {
            showInputBox: async options => { rec.inputs.push(options); return answer(); },
            showWarningMessage: async (...args) => { rec.warnings.push(args); return args.length > 1 ? answer() : undefined; },
            showErrorMessage: async message => { rec.errors.push(message); },
            createTerminal: options => {
                if (rec.noTerminal) throw new Error('no terminal here');
                const terminal = { options, sent: [], shown: 0, sendText(line) { this.sent.push(line); }, show() { this.shown += 1; } };
                rec.terminals.push(terminal);
                return terminal;
            }
        },
        commands: {
            registerCommand: (id, callback) => { assert.ok(!rec.commands.has(id), `${id} registered twice`); rec.commands.set(id, callback); return { dispose() {} }; },
            executeCommand: async (name, key, value) => { assert.equal(name, 'setContext'); rec.context.set(key, value); }
        },
        env: { clipboard: { writeText: async line => { rec.clipboard.push(line); } } }
    };
    const mod = load(files.provider, name => {
        if (name === 'vscode') return vscode;
        if (name === '../util/AccountPresentation') return presentation;
        throw new Error(`AccountsTreeProvider.ts must not require ${name}`);
    });
    const events = { accounts: new Emitter(), connection: new Emitter(), state: new Emitter(), added: new Emitter() };
    const sender = name => (...args) => { rec.sends.push([name, ...args]); return rec.result; };
    const client = {
        connectionState: connected ? 'connected' : 'disconnected', isStateReady: true, accountRotation: rotation,
        onAccountsChanged: events.accounts.event, onConnectionChanged: events.connection.event, onStateChanged: events.state.event, onAccountAdded: events.added.event,
        addAccount: sender('addAccount'), removeAccount: sender('removeAccount'), moveAccount: sender('moveAccount'),
        renameAccount: sender('renameAccount'), setAccountSwitchPercent: sender('setAccountSwitchPercent')
    };
    const provider = new mod.AccountsTreeProvider(client, clock);
    if (register) provider.registerCommands();
    const node = id => provider.getChildren().find(n => n.id === id);
    const run = (name, target) => rec.commands.get(`moe.accounts.${name}`)(target);
    const line = args => mod.accountsCommandLine(rotation.cli, rotation.registryFile, args, process.platform === 'win32');
    return { mod, provider, client, events, rec, node, run, line };
}

/** One terminal, named by the bundle, that ran exactly this CLI line and was shown. */
function assertTerminal(s, args) {
    assert.equal(s.rec.terminals.length, 1);
    const [terminal] = s.rec.terminals;
    assert.equal(terminal.options.name, t('moe.accounts.terminal.tab'));
    assert.deepEqual(terminal.sent, [s.line(args)]);
    assert.equal(terminal.shown, 1);
}

test('P2: package.json declares the seven commands with menus scoped to moe.accounts; registerCommands registers exactly them, once', () => {
    const { contributes } = readJson(files.manifest);
    const declared = new Map(contributes.commands.filter(c => COMMANDS.includes(c.command)).map(c => [c.command, c]));
    assert.deepEqual([...declared.keys()].sort(), [...COMMANDS].sort());
    NAMES.slice(0, 6).forEach(name => assert.equal(declared.get(`moe.accounts.${name}`).title, t(`moe.accounts.button.${name}`)));
    declared.forEach(command => assert.equal(command.category, 'Moe Accounts'));
    const when = (menu, name) => contributes.menus[menu].filter(m => m.command === `moe.accounts.${name}`).map(m => m.when);
    assert.deepEqual(when('view/title', 'add'), ['view == moe.accounts && moe.accounts.canAdd']);
    assert.deepEqual(when('view/title', 'setSwitchPercent'), ['view == moe.accounts && moe.accounts.canSwitchAt']);
    for (const [name, token] of [['signIn', 'canSignIn'], ['remove', 'canRemove'], ['moveUp', 'canMoveUp'], ['moveDown', 'canMoveDown'], ['rename', 'canRename']]) {
        assert.deepEqual(when('view/item/context', name), [`view == moe.accounts && viewItem =~ /\\b${token}\\b/`]);
    }
    NAMES.forEach(name => assert.deepEqual(when('commandPalette', name), ['false']));
    const { provider, rec } = setup();
    assert.deepEqual([...rec.commands.keys()].sort(), [...COMMANDS].sort());
    assert.throws(() => provider.registerCommands(), /AccountsTreeProvider/);
    assert.match(read(files.extension), /^\s*context\.subscriptions\.push\(\.\.\.accountsProvider\.registerCommands\(\)\);$/m);
});

test('K1: before registerCommands the provider sets no context key and keeps the bare read-only contextValue', () => {
    const s = setup(undefined, { register: false });
    Object.values(s.events).forEach(e => e.fire());
    s.provider.refresh();
    assert.equal(s.rec.context.size, 0);
    assert.deepEqual(s.provider.getChildren().map(n => n.contextValue), ['moe.account', 'moe.account', 'moe.account', 'moe.account']);
    s.events.added.fire('acct-1');
    assert.equal(s.rec.terminals.length, 0);
    s.provider.registerCommands();
    assert.deepEqual([...s.rec.context], [['moe.accounts.canAdd', true], ['moe.accounts.canSwitchAt', true]]);
});

test('K2: for every corpus row the context keys and row tokens equal AccountPresentation.actions', () => {
    const failures = [];
    corpus.rows.forEach((row, index) => {
        const s = setup(); // C05, connected: every row below must move the keys through an event refresh
        s.client.accountRotation = row.rotation;
        s.client.connectionState = row.connected ? 'connected' : 'disconnected';
        (index % 2 === 0 ? s.events.accounts : s.events.connection).fire();
        const e = row.expectActions;
        const got = [s.rec.context.get('moe.accounts.canAdd'), s.rec.context.get('moe.accounts.canSwitchAt'), tokens(s.provider.contextFor(row.selectedId))];
        if (JSON.stringify(got) !== JSON.stringify([e.add, e.switchAt, row.selectedId === null ? [] : expected(e)])) failures.push(`${row.id} selected ${JSON.stringify(got)}`);
        const rotation = presentation.parseAccountRotation(row.rotation);
        for (const element of s.provider.getChildren().filter(n => n.id !== undefined)) { // while disconnected too (C09 lists its rows, VSC-25)
            const item = s.provider.getTreeItem(element);
            if (JSON.stringify(tokens(item.contextValue)) !== JSON.stringify(expected(presentation.actions(rotation, element.id, row.connected)))) failures.push(`${row.id} ${element.id} ${item.contextValue}`);
        }
    });
    assert.deepEqual(failures, [], `failing rows: ${failures.join('; ')}`);
});

test('A1: add sends addAccount once after a valid label, nothing on a cancel or a rejected label, then signs in only the added account', async () => {
    const s = setup();
    s.rec.answers.push('Work Max');
    await s.run('add');
    assert.deepEqual(s.rec.sends, [['addAccount', 'Work Max']]);
    const box = s.rec.inputs[0];
    assert.deepEqual([box.title, box.prompt, box.value], [t('moe.accounts.add.title'), t('moe.accounts.add.prompt'), '']);
    assert.deepEqual([box.validateInput('x'.repeat(65)), box.validateInput(`a${String.fromCharCode(7)}`), box.validateInput('ok')], [LABEL_HINT, LABEL_HINT, undefined]);
    s.events.added.fire('acct-new');
    assertTerminal(s, ['login', 'acct-new']);
    s.events.added.fire('acct-other');
    for (const answer of [undefined, 'x'.repeat(65), `a${String.fromCharCode(7)}b`]) {
        s.rec.answers.push(answer);
        await s.run('add');
    }
    s.events.added.fire('acct-late');
    assert.equal(s.rec.sends.length, 1);
    assert.equal(s.rec.terminals.length, 1, 'an ACCOUNT_ADDED nobody asked for here must not sign in');
});

test('A2: sign in opens one terminal running login <id>; no CLI or a stale element opens none', async () => {
    const s = setup();
    await s.run('signIn', s.node('acct-2'));
    assertTerminal(s, ['login', 'acct-2']);
    await s.run('signIn', { label: 'gone', id: 'acct-gone' });
    const c11 = setup(rowOf('C11').rotation);
    await c11.run('signIn', c11.node('acct-a'));
    c11.rec.answers.push('Work'); // an add on a daemon with no CLI: its ACCOUNT_ADDED has nothing to run
    await c11.run('add');
    c11.events.added.fire('acct-new');
    assert.deepEqual([s.rec.terminals.length, c11.rec.terminals.length, s.rec.sends.length, c11.rec.sends.length, c11.rec.errors], [1, 0, 0, 1, []]);
});

test('A3: remove asks in a modal; Remove only sends removeAccount, Sign out and remove runs the CLI, a dismiss does nothing', async () => {
    const s = setup();
    const node = s.node('acct-2');
    s.rec.answers.push(t('moe.accounts.remove.only'));
    await s.run('remove', node);
    assert.deepEqual(s.rec.sends, [['removeAccount', 'acct-2']]);
    assert.deepEqual(s.rec.warnings[0][0], t('moe.accounts.remove.confirm', 'Personal'));
    assert.equal(s.rec.warnings[0][1].modal, true);
    assert.deepEqual(s.rec.warnings[0].slice(2), [t('moe.accounts.remove.signOut'), t('moe.accounts.remove.only')]);
    s.rec.answers.push(t('moe.accounts.remove.signOut'));
    await s.run('remove', node);
    assertTerminal(s, ['remove', 'acct-2', '--sign-out']);
    s.rec.answers.push(undefined);
    await s.run('remove', node);
    assert.deepEqual([s.rec.sends.length, s.rec.terminals.length, s.rec.warnings.length], [1, 1, 3]);
    const c11 = setup(rowOf('C11').rotation); // no CLI: only Remove only is offered
    c11.rec.answers.push(t('moe.accounts.remove.signOut'));
    await c11.run('remove', c11.node('acct-b'));
    assert.deepEqual([c11.rec.warnings[0].slice(2), c11.rec.sends, c11.rec.terminals.length], [[t('moe.accounts.remove.only')], [], 0]);
});

test('A4: move up and down send moveAccount(id, -1) and (id, 1); an edge or a dropped connection sends nothing', async () => {
    const s = setup();
    await s.run('moveUp', s.node('acct-2'));
    await s.run('moveDown', s.node('acct-2'));
    await s.run('moveUp', s.node('acct-1'));
    await s.run('moveDown', s.node('acct-4'));
    const stale = s.node('acct-3');
    s.client.connectionState = 'disconnected'; // the menu was built while connected
    await s.run('moveUp', stale);
    await s.run('moveDown', stale);
    assert.deepEqual(s.rec.sends, [['moveAccount', 'acct-2', -1], ['moveAccount', 'acct-2', 1]]);
});

test('A5: rename sends a new label once; a cancel, a rejected or an unchanged label sends nothing; empty clears it', async () => {
    const s = setup();
    const node = s.node('acct-1');
    for (const answer of ['Team Max', undefined, 'x'.repeat(65), 'Work Max', '  Work Max ', '']) {
        s.rec.answers.push(answer);
        await s.run('rename', node);
    }
    assert.deepEqual(s.rec.sends, [['renameAccount', 'acct-1', 'Team Max'], ['renameAccount', 'acct-1', '']]);
    const box = s.rec.inputs[0];
    assert.deepEqual([box.title, box.prompt, box.value, box.validateInput('x'.repeat(65))], [t('moe.accounts.rename.title'), t('moe.accounts.rename.prompt'), 'Work Max', LABEL_HINT]);
});

test('A6: switch percent sends a new whole 1..100 value once; a cancel, the current value or a bad number sends nothing', async () => {
    const s = setup();
    for (const answer of ['75', undefined, '90', '0', '101', '7.5', 'x', '', '-5']) {
        s.rec.answers.push(answer);
        await s.run('setSwitchPercent');
    }
    assert.deepEqual(s.rec.sends, [['setAccountSwitchPercent', 75]]);
    const box = s.rec.inputs[0];
    assert.deepEqual([box.title, box.prompt, box.value], [t('moe.accounts.switchAt'), `1-100${t('moe.accounts.switchAt.unit')}`, '90']);
    assert.deepEqual(['7.5', '0', '101', 'x', '100', '1'].map(box.validateInput), [PERCENT_HINT, PERCENT_HINT, PERCENT_HINT, PERCENT_HINT, undefined, undefined]);
});

test('A7: every sender that returns false shows the not-connected warning exactly once, and a failed add signs nothing in', async () => {
    const cases = [['add', null, ['Work']], ['remove', 'acct-2', [t('moe.accounts.remove.only')]], ['moveUp', 'acct-2', []], ['moveDown', 'acct-2', []], ['rename', 'acct-2', ['Mine']], ['setSwitchPercent', null, ['80']]];
    for (const [name, id, answers] of cases) {
        const s = setup();
        s.rec.result = false;
        s.rec.answers.push(...answers);
        await s.run(name, id === null ? undefined : s.node(id));
        assert.equal(s.rec.sends.length, 1, name);
        assert.deepEqual(s.rec.warnings.filter(w => w[0] === NOT_CONNECTED), [[NOT_CONNECTED]], name);
        s.events.added.fire('acct-new');
        assert.equal(s.rec.terminals.length, 0, name);
    }
});

test('K3: a full list of 32 accounts turns canAdd off and keeps canSwitchAt on, and add then opens no dialog', async () => {
    const rotation = structuredClone(rowOf('C05').rotation);
    rotation.accounts = Array.from({ length: 32 }, (_, i) => ({ ...rotation.accounts[0], id: `acct-${i}`, label: `A${i}` }));
    const s = setup(rotation);
    assert.deepEqual([s.rec.context.get('moe.accounts.canAdd'), s.rec.context.get('moe.accounts.canSwitchAt')], [false, true]);
    s.rec.answers.push('More');
    await s.run('add');
    assert.deepEqual([s.rec.inputs.length, s.rec.sends], [0, []]);
});

test('A8: a stale menu opens no dialog, and a connection that drops while the dialog is open sends nothing', async () => {
    const noCli = structuredClone(rowOf('C05').rotation);
    delete noCli.cli; // with no connection either, remove has no choice left
    const cases = [['add', null, 'Work'], ['remove', 'acct-2', t('moe.accounts.remove.only')], ['rename', 'acct-2', 'Mine'], ['setSwitchPercent', null, '80']];
    for (const [name, id, reply] of cases) {
        const s = setup();
        s.rec.answers.push(() => { s.client.connectionState = 'disconnected'; return reply; });
        await s.run(name, id === null ? undefined : s.node(id));
        assert.deepEqual([s.rec.inputs.length + s.rec.warnings.length, s.rec.sends], [1, []], name);
        s.client.accountRotation = noCli; // still disconnected: the menu entry is stale
        s.rec.answers.push(reply);
        await s.run(name, id === null ? undefined : { id, label: id });
        assert.deepEqual([s.rec.inputs.length + s.rec.warnings.length, s.rec.sends], [1, []], `${name} (stale menu)`);
    }
});

test('Q1: the CLI line quotes every word for bash and PowerShell, and a control character is refused before any terminal opens', async () => {
    const { mod } = setup();
    const cli = { node: '/opt/my node/node', script: "/opt/moe's/cli.js" };
    const file = 'C:\\Users\\A B\\claude accounts.json';
    const id = 'acct-"q" 1';
    assert.equal(mod.accountsCommandLine(cli, file, ['login', id], false),
        `'/opt/my node/node' '/opt/moe'\\''s/cli.js' '--accounts-file' 'C:\\Users\\A B\\claude accounts.json' 'login' 'acct-"q" 1'`);
    const encoded = /^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/]+=*)$/.exec(mod.accountsCommandLine(cli, file, ['login', id], true));
    assert.ok(encoded, 'PowerShell gets one -EncodedCommand word');
    assert.equal(Buffer.from(encoded[1], 'base64').toString('utf16le'),
        `& '/opt/my node/node' '/opt/moe''s/cli.js' '--accounts-file' 'C:\\Users\\A B\\claude accounts.json' 'login' 'acct-"q" 1'`);
    for (const bad of [13, 10, 0, 0x15, 0x17, 0x7f].map(code => String.fromCharCode(code))) { // CR, LF, NUL, Ctrl-U, Ctrl-W, DEL
        for (const windows of [false, true]) {
            assert.throws(() => mod.accountsCommandLine(cli, file, ['login', `a${bad}b`], windows), /control characters/);
            assert.throws(() => mod.accountsCommandLine(cli, `f${bad}`, ['check'], windows), /control characters/);
        }
    }
    const rotation = structuredClone(rowOf('C05').rotation);
    rotation.accounts[1].id = 'acct-2\ntouch /tmp/x';
    const s = setup(rotation);
    await s.run('signIn', s.node(rotation.accounts[1].id));
    assert.equal(s.rec.terminals.length, 0);
    assert.equal(s.rec.errors.length, 1);
    assert.match(s.rec.errors[0], /^Account action failed: .*control characters/);
});

test('S1: dialog texts resolve through AccountPresentation.ACCOUNT_TEXT, equal MoeBundle.properties, and a missing terminal copies the line and shows the bundle warning', async () => {
    const { mod } = setup();
    const keys = ['add.title', 'add.prompt', 'rename.title', 'rename.prompt', 'remove.confirm', 'remove.signOut', 'remove.only', 'terminal.tab', 'terminal.unavailable', 'switchAt', 'switchAt.unit'].map(k => `moe.accounts.${k}`);
    assert.equal(mod.ACCOUNT_ACTION_TEXT, undefined, 'the provider keeps no second text table');
    const source = read(files.provider);
    assert.doesNotMatch(source, /ACCOUNT_ACTION_TEXT/);
    assert.doesNotMatch(source, /\bsay\(/, 'the provider keeps no second resolver');
    for (const key of keys) {
        assert.ok(bundle.has(key), `${key} is missing from the bundle`);
        assert.ok(Object.hasOwn(presentation.ACCOUNT_TEXT, key), `${key} is missing from AccountPresentation.ACCOUNT_TEXT`);
        assert.equal(presentation.ACCOUNT_TEXT[key], bundle.get(key), key);
    }
    const s = setup();
    s.rec.noTerminal = true;
    await s.run('signIn', s.node('acct-4'));
    const line = s.line(['login', 'acct-4']);
    assert.deepEqual([s.rec.clipboard, s.rec.warnings, s.rec.errors], [[line], [[t('moe.accounts.terminal.unavailable', line)]], []]);
});

/** The top-level `function` declarations of the three quoting helpers in a source file, by name, as their AST text (leading comments excluded). */
const QUOTE_HELPERS = ['psQuote', 'shQuote', 'assertSafeArg'];
function helperTexts(file) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2020, true);
    const found = new Map();
    for (const statement of source.statements) {
        if (!ts.isFunctionDeclaration(statement) || statement.name === undefined || !QUOTE_HELPERS.includes(statement.name.text)) continue;
        assert.ok(!found.has(statement.name.text), `${file} declares ${statement.name.text} twice`);
        found.set(statement.name.text, statement.getText(source));
    }
    return found;
}

test('Q2: the provider keeps text-identical copies of AgentLauncher.ts psQuote, shQuote and assertSafeArg', () => {
    // A shared module is not possible: powershell-quoting and agent-launcher-controls load both files under closed require maps.
    const launcher = helperTexts(files.launcher);
    const provider = helperTexts(files.provider);
    assert.deepEqual([...launcher.keys()].sort(), [...QUOTE_HELPERS].sort(), 'AgentLauncher.ts must declare each helper once as a function');
    assert.deepEqual([...provider.keys()].sort(), [...QUOTE_HELPERS].sort(), 'AccountsTreeProvider.ts must declare each helper once as a function');
    for (const name of QUOTE_HELPERS) assert.equal(provider.get(name), launcher.get(name), `${name} drifted between AccountsTreeProvider.ts and AgentLauncher.ts: change both copies together`);
});

test('C09: disconnected with a cached rotation lists its rows, keeps the CLI actions and drops the list edits', async () => {
    const row = rowOf('C09');
    const e = row.expectActions;
    const en = ({ key, args }) => t(key, ...args);
    const s = setup(row.rotation, { connected: false });
    const nodes = s.provider.getChildren();
    assert.deepEqual(nodes.map(n => n.id), row.expectRows.map(r => r.id), 'rows equal expectRows');
    assert.deepEqual(nodes.map(n => n.label), row.expectRows.map(r => `${r.position}. ${r.label}`));
    assert.deepEqual(nodes.map(n => n.description), row.expectRows.map(r => `${en(r.status)} · ${t('moe.accounts.column.fiveHour')}: ${en(r.fiveHour)} · ${t('moe.accounts.column.weekly')}: ${en(r.weekly)}`));
    assert.deepEqual(tokens(s.provider.contextFor(row.selectedId)), expected(e));
    assert.deepEqual([s.rec.context.get('moe.accounts.canAdd'), s.rec.context.get('moe.accounts.canSwitchAt')], [e.add, e.switchAt]);
    const selected = s.node(row.selectedId);
    assert.ok(selected, `${row.selectedId} must be listed while disconnected`);
    await s.run('signIn', selected);
    assertTerminal(s, ['login', row.selectedId]);
    for (const name of ['moveUp', 'moveDown', 'rename', 'add', 'setSwitchPercent']) await s.run(name, selected);
    assert.deepEqual([s.rec.sends, s.rec.inputs.length, s.rec.warnings.length, s.rec.errors], [[], 0, 0, []], 'list edits do nothing while disconnected');
    s.rec.answers.push(undefined);
    await s.run('remove', selected); // only the CLI half of remove is offered
    assert.deepEqual([s.rec.warnings.length, s.rec.warnings[0].slice(2), s.rec.sends], [1, [t('moe.accounts.remove.signOut')], []]);
    s.client.accountRotation = undefined; // no snapshot yet: nothing to list
    s.events.connection.fire();
    assert.deepEqual(s.provider.getChildren().map(n => n.label), [t('moe.accounts.notConnected')]);
});

'use strict';

// VSC-14: the read-only Claude accounts view (AccountsTreeProvider) is the VS Code counterpart of the JetBrains Accounts
// tab. It renders VSC-13's AccountPresentation rows and chips, held to the shared accounts corpus (VSC-7) and to
// MoeBundle.properties. The corpus and the bundle are read here, never edited. The provider loads under node:vm with a
// closed require map (vscode and AccountPresentation only), which also proves its MoeDaemonClient import is type-only.
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

const bundle = new Map([...read(files.bundle).matchAll(/^(moe\.[A-Za-z.]+)=(.*?)\r?$/gm)].map(m => [m[1], m[2]]));
const en = ({ key, args }) => {
    assert.ok(bundle.has(key), `${key} is missing from ${files.bundle}`);
    return bundle.get(key).replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)]));
};
const t = (key, ...args) => en({ key, args });
const SEPARATOR = '  ·  ';
const COLUMNS = ['signIn', 'fiveHour', 'weekly', 'status', 'vmToken'];

const corpus = readJson(files.corpus);
const rowOf = id => {
    const found = corpus.rows.find(r => r.id === id);
    assert.ok(found, `corpus row ${id} is missing`);
    return found;
};
const clock = { now: () => Date.parse(corpus.now), zone: () => corpus.zone };

class Emitter {
    constructor() {
        this.listeners = new Set();
        this.disposed = false;
        this.late = 0; // fires after dispose
        this.event = listener => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; };
    }
    fire(value) {
        if (this.disposed) this.late += 1;
        for (const listener of [...this.listeners]) listener(value);
    }
    dispose() { this.disposed = true; this.listeners.clear(); }
}

/** A provider loaded from source with a fake vscode and a fake client, whose three events are Emitters. */
function setup(rotation, clientState = {}, provided = clock) {
    const created = [];
    const vscode = {
        EventEmitter: class extends Emitter { constructor() { super(); created.push(this); } },
        TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
        TreeItemCollapsibleState: { None: 0 }
    };
    const presentation = load(files.presentation, name => { throw new Error(`AccountPresentation.ts must not require ${name}`); });
    const { AccountsTreeProvider } = load(files.provider, name => {
        if (name === 'vscode') return vscode;
        if (name === '../util/AccountPresentation') return presentation;
        throw new Error(`AccountsTreeProvider.ts must not require ${name}`);
    });
    const events = { accounts: new Emitter(), connection: new Emitter(), state: new Emitter() };
    const client = {
        connectionState: 'connected', isStateReady: true, accountRotation: rotation, ...clientState,
        onAccountsChanged: events.accounts.event, onConnectionChanged: events.connection.event, onStateChanged: events.state.event
    };
    const provider = provided === undefined ? new AccountsTreeProvider(client) : new AccountsTreeProvider(client, provided);
    let fired = 0;
    provider.onDidChangeTreeData(() => { fired += 1; });
    return { provider, client, events, own: created[0], fires: () => fired, view: { description: undefined, message: undefined } };
}

const labels = provider => provider.getChildren().map(node => node.label);
const listeners = events => Object.values(events).map(e => e.listeners.size);

test('P1: package.json declares the moe.accounts view, the refresh command and its view/title entry', () => {
    const { contributes } = readJson(files.manifest);
    assert.deepEqual(contributes.views.moe.filter(v => v.id === 'moe.accounts'), [{ id: 'moe.accounts', name: t('moe.accounts.title') }]);
    const commands = contributes.commands.filter(c => c.command === 'moe.accounts.refresh');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].icon, '$(refresh)');
    assert.ok(typeof commands[0].title === 'string' && commands[0].title.length > 0);
    assert.deepEqual(contributes.menus['view/title'].filter(m => m.command === 'moe.accounts.refresh'),
        [{ command: 'moe.accounts.refresh', when: 'view == moe.accounts', group: 'navigation@1' }]);
});

test('V1: two accounts of corpus row C05 give two items in row order, in MoeBundle English', () => {
    const c05 = rowOf('C05');
    assert.ok(c05.rotation.accounts.length >= 2 && c05.expectRows.length >= 2);
    const { provider } = setup({ ...c05.rotation, accounts: c05.rotation.accounts.slice(0, 2) });
    const nodes = provider.getChildren();
    assert.equal(nodes.length, 2);
    nodes.forEach((node, index) => {
        const e = c05.expectRows[index];
        const item = provider.getTreeItem(node);
        assert.equal(item.label, `${e.position}. ${e.label}`);
        assert.equal(item.collapsibleState, 0);
        assert.equal(item.id, e.id);
        assert.equal(item.contextValue, 'moe.account');
        assert.equal(item.description, `${en(e.status)} · ${t('moe.accounts.column.fiveHour')}: ${en(e.fiveHour)} · ${t('moe.accounts.column.weekly')}: ${en(e.weekly)}`);
        assert.equal(item.tooltip, COLUMNS.map(name => `${t(`moe.accounts.column.${name}`)}: ${en(e[name])}`).join('\n'));
        assert.deepEqual(provider.getChildren(node), []);
    });
});

test('V1b: the full C05 rotation puts the chips line in the view description and no note in its message', () => {
    const c05 = rowOf('C05');
    const { provider, view } = setup(c05.rotation);
    assert.equal(provider.getChildren().length, c05.expectRows.length);
    provider.attach(view);
    assert.equal(view.description, t('moe.accounts.header', c05.expectChips.map(en).join(SEPARATOR)));
    assert.equal(view.message, undefined);
});

test('V2: each client event fires onDidChangeTreeData once and re-renders the view', () => {
    for (const name of ['accounts', 'connection', 'state']) {
        const { provider, events, fires, client, view } = setup(rowOf('C05').rotation);
        provider.attach(view);
        assert.ok(view.description !== undefined);
        client.accountRotation = rowOf('C02').rotation; // what the daemon now reports
        events[name].fire();
        assert.equal(fires(), 1, `${name} must fire once`);
        assert.deepEqual(labels(provider), [t('moe.accounts.empty')]);
        assert.equal(view.description, undefined, `${name} must re-apply the view description`);
    }
});

test('V3: not connected shows the cached rotation like connected (JetBrains AccountsPanel.render); no rotation and an empty account list each give one state item', () => {
    const c05 = rowOf('C05').rotation;
    const online = setup(c05);
    online.provider.attach(online.view);
    assert.ok(online.provider.getChildren().length > 1 && online.view.description !== undefined);
    for (const connectionState of ['disconnected', 'connecting']) {
        const off = setup(c05, { connectionState }); // the cached rotation survives a dropped socket
        off.provider.attach(off.view);
        assert.deepEqual(off.provider.getChildren(), online.provider.getChildren(), `${connectionState}: same rows as connected`);
        assert.deepEqual([off.view.description, off.view.message], [online.view.description, online.view.message], `${connectionState}: same chips and note`);
        for (const isStateReady of [true, false]) { // with no rotation yet, not connected is not-connected whatever isStateReady says
            assert.deepEqual(labels(setup(undefined, { connectionState, isStateReady }).provider), [t('moe.accounts.notConnected')], `${connectionState} isStateReady=${isStateReady}`);
        }
    }
    assert.deepEqual(labels(setup(undefined, { isStateReady: true }).provider), [t('moe.accounts.unsupported')]);
    assert.deepEqual(labels(setup(undefined, { isStateReady: false }).provider), [t('moe.accounts.notConnected')]);
    for (const bad of [null, 7, 'x', [], {}, { registryFile: ' ' }]) assert.deepEqual(labels(setup(bad).provider), [t('moe.accounts.unsupported')]);
    const c02 = setup(rowOf('C02').rotation);
    assert.deepEqual(labels(c02.provider), [t('moe.accounts.empty')]);
    for (const { provider } of [c02, setup(undefined)]) {
        const item = provider.getTreeItem(provider.getChildren()[0]);
        assert.deepEqual([item.id, item.contextValue, item.description, item.tooltip], [undefined, undefined, undefined, undefined]); // no row actions on a state item
    }
});

test('V4: an account-file error gives no items and the error message; a missing CLI gives the note', () => {
    const c03 = rowOf('C03');
    const failed = setup(c03.rotation);
    failed.provider.attach(failed.view);
    assert.deepEqual(failed.provider.getChildren(), []);
    assert.equal(failed.view.message, t('moe.accounts.error', c03.rotation.error));
    assert.equal(failed.view.description, t('moe.accounts.header', c03.expectChips.map(en).join(SEPARATOR)));
    const c11 = rowOf('C11');
    const noCli = setup(c11.rotation);
    noCli.provider.attach(noCli.view);
    assert.equal(noCli.provider.getChildren().length, c11.expectRows.length);
    assert.equal(noCli.view.message, t('moe.accounts.noCli'));
});

test('V5: the provider never throws, with the local clock, an unknown zone or a hostile rotation', () => {
    const c05 = rowOf('C05').rotation;
    assert.equal(setup(c05, {}, undefined).provider.getChildren().length, c05.accounts.length);
    assert.equal(setup(c05, {}, { now: clock.now, zone: () => 'Not/AZone' }).provider.getChildren().length, c05.accounts.length);
    const hostile = { registryFile: 'f', accounts: [3, null, { id: ' ' }, { id: 'a', label: 7, windows: { __proto__: 1, x: 3 }, seats: [1] }, { id: 'a' }], cli: 5, error: 9 };
    const { provider, view } = setup(hostile);
    provider.attach(view);
    assert.equal(provider.getChildren().length, 1);
    for (const connectionState of ['disconnected', 'connecting']) { // parts() now parses the rotation on the not-connected path too
        const off = setup(hostile, { connectionState });
        off.provider.attach(off.view);
        assert.equal(off.provider.getChildren().length, 1, connectionState);
        for (const bad of [null, 7, 'x', [], {}, { registryFile: ' ' }]) assert.deepEqual(labels(setup(bad, { connectionState }).provider), [t('moe.accounts.notConnected')], `${connectionState} ${JSON.stringify(bad)}`);
    }
});

test('V6: dispose removes every listener, silences the provider and tolerates a second call', () => {
    const { provider, events, own, fires, view } = setup(rowOf('C05').rotation);
    provider.attach(view);
    assert.deepEqual(listeners(events), [1, 1, 1]);
    provider.dispose();
    assert.deepEqual(listeners(events), [0, 0, 0]);
    assert.equal(own.disposed, true);
    const before = { ...view };
    Object.values(events).forEach(e => e.fire());
    provider.refresh();
    assert.equal(fires(), 0);
    assert.equal(own.late, 0, 'refresh after dispose must not fire the disposed emitter');
    const other = { description: 'kept', message: 'kept' };
    provider.attach(other);
    provider.refresh();
    assert.deepEqual(other, { description: 'kept', message: 'kept' });
    assert.deepEqual(view, before);
    provider.dispose();
});

test('X1: extension.ts creates the provider and the TreeView, attaches it and registers the refresh command', () => {
    const source = read(files.extension);
    assert.match(source, /^import \{ AccountsTreeProvider \} from '\.\/providers\/AccountsTreeProvider';$/m);
    assert.match(source, /const accountsProvider = new AccountsTreeProvider\(daemonClient\);/);
    assert.match(source, /const accountsView = vscode\.window\.createTreeView\('moe\.accounts', \{ treeDataProvider: accountsProvider \}\);/);
    assert.match(source, /accountsProvider\.attach\(accountsView\);/);
    assert.match(source, /context\.subscriptions\.push\(\s*accountsProvider,\s*accountsView,\s*vscode\.commands\.registerCommand\('moe\.accounts\.refresh', \(\) => accountsProvider\.refresh\(\)\)\s*\);/);
});

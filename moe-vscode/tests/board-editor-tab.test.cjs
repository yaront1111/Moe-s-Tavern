'use strict';

// The task board is an editor tab in the column the task views open in, not a sidebar view.
// There is one board tab: opening it again brings it forward, closing it lets a new one open,
// and a tab VS Code restores after a reload replaces one opened meanwhile instead of doubling it.
// Runs the real BoardViewProvider (transpiled under node:vm) against a fake vscode window.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const PROVIDER = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '..', 'src/providers/BoardViewProvider.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }
).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const STATE = { tasks: [], epics: [] };

function fakePanel(created) {
    const listeners = { dispose: [], viewState: [] };
    const panel = {
        created, visible: true, disposed: false, reveals: [], posted: [], handler: undefined,
        webview: {
            html: '', options: {}, cspSource: 'vscode-webview://test', asWebviewUri: uri => uri.path,
            onDidReceiveMessage: fn => { panel.handler = fn; return { dispose() {} }; },
            postMessage: message => { panel.posted.push(plain(message)); return Promise.resolve(true); }
        },
        onDidDispose: fn => { listeners.dispose.push(fn); return { dispose() {} }; },
        onDidChangeViewState: fn => { listeners.viewState.push(fn); return { dispose() {} }; },
        reveal: (column, preserveFocus) => { panel.reveals.push([column, preserveFocus]); },
        dispose: () => {
            if (panel.disposed) { return; }
            panel.disposed = true;
            listeners.dispose.forEach(fn => fn());
        }
    };
    return panel;
}

function openProvider() {
    const h = { panels: [], stateListeners: [] };
    const subscription = () => ({ dispose() {} });
    const vscode = {
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join('/') }) },
        window: {
            createWebviewPanel: (viewType, title, showOptions, options) => {
                const panel = fakePanel(plain({ viewType, title, showOptions, options }));
                h.panels.push(panel);
                return panel;
            }
        }
    };
    const deps = {
        vscode,
        '../panels/EpicDetailPanel': {}, '../panels/TaskCreatePanel': {}, '../panels/PlanReviewPanel': {}, '../panels/TaskDetailPanel': {}
    };
    const module = { exports: {} };
    vm.runInContext(PROVIDER, vm.createContext({
        module, exports: module.exports, process: { env: {} },
        setTimeout: () => 0, clearTimeout: () => {},
        require: dep => {
            if (Object.prototype.hasOwnProperty.call(deps, dep)) { return deps[dep]; }
            throw new Error(`unexpected require: ${dep}`);
        }
    }), { filename: 'BoardViewProvider.ts' });
    const client = {
        connectionState: 'connected', currentState: STATE,
        onStateChanged: fn => { h.stateListeners.push(fn); return { dispose() {} }; },
        onError: subscription, onConnectionChanged: subscription, onActivityLog: subscription
    };
    h.provider = new module.exports.BoardViewProvider({ path: '/ext' }, client);
    h.changeState = () => h.stateListeners.forEach(fn => fn(STATE));
    return h;
}

const statePosts = panel => panel.posted.filter(message => message.type === 'updateState').length;

test('board-tab T1: the board opens once, as an editor tab in the task views\u2019 column, and opening it again brings it forward', () => {
    const h = openProvider();
    h.provider.show();
    h.provider.show(true);

    assert.equal(h.panels.length, 1, 'a second open reuses the tab');
    const [panel] = h.panels;
    assert.deepEqual(panel.created, {
        viewType: 'moe.boardPanel',
        title: 'Moe Task Board',
        showOptions: { viewColumn: 1, preserveFocus: false },
        options: { enableScripts: true, localResourceRoots: [{ path: '/ext' }], retainContextWhenHidden: true }
    });
    assert.deepEqual(panel.reveals, [[undefined, true]], 'revealed where the user left it');
    assert.ok(panel.webview.html.includes('board.js'), 'the tab hosts the board page');
    assert.ok(statePosts(panel) > 0, 'the tab gets the board state at once');
    h.provider.dispose();
});

test('board-tab T2: after the tab is closed the board is not open, state changes are dropped, and opening makes a new tab', () => {
    const h = openProvider();
    h.provider.show();
    const [first] = h.panels;
    first.dispose();

    assert.equal(h.provider.isOpen, false);
    const before = first.posted.length;
    h.changeState();
    assert.equal(first.posted.length, before, 'nothing is posted to a closed tab');

    h.provider.show();
    assert.equal(h.panels.length, 2);
    assert.equal(h.provider.isOpen, true);
    h.provider.dispose();
});

test('board-tab T3: a tab restored after a reload replaces the one opened meanwhile, and takes the board state', async () => {
    const h = openProvider();
    h.provider.show(true);
    const [opened] = h.panels;
    const restored = fakePanel(undefined);

    await h.provider.deserializeWebviewPanel(restored, undefined);

    assert.equal(opened.disposed, true, 'the tab opened meanwhile is closed');
    assert.equal(restored.disposed, false);
    assert.equal(h.provider.isOpen, true, 'closing the other tab does not detach the restored one');
    assert.deepEqual(plain(restored.webview.options), { enableScripts: true, localResourceRoots: [{ path: '/ext' }] });
    const before = statePosts(restored);
    h.changeState();
    assert.equal(statePosts(restored), before + 1, 'state changes reach the restored tab');

    h.provider.show();
    assert.equal(h.panels.length, 1, 'opening the board again reuses the restored tab');
    assert.deepEqual(restored.reveals, [[undefined, false]]);
    h.provider.dispose();
});

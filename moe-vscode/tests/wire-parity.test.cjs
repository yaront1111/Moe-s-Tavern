'use strict';

// Wire parity with JetBrains (VSC-6): RELEASE_TASK out, CHANNEL_DELETED in.
// Runs the PRODUCTION MoeDaemonClient and ChatViewProvider (transpiled, each under its own
// node:vm context with a closed require map) and the RAW media/chat.js page script, so every
// assertion crosses socket frame -> client cache -> provider post -> page. Frames and
// webview posts are JSON-parsed in the test realm, because vm-realm objects fail
// deepStrictEqual against test-realm ones.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const CLIENT_PATH = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const PROVIDER_PATH = path.join(__dirname, '../src/providers/ChatViewProvider.ts');
const PAGE_PATH = path.join(__dirname, '../media/chat.js');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const CLIENT_JS = compile(CLIENT_PATH);
const PROVIDER_JS = compile(PROVIDER_PATH);
const PAGE_JS = fs.readFileSync(PAGE_PATH, 'utf8');

const WS_OPEN = 1;
const jsonCopy = value => JSON.parse(JSON.stringify(value));

/** vscode.EventEmitter stand-in that records listeners so `fire` reaches subscribers. */
class RecordingEventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
        };
    }
    fire(payload) {
        for (const listener of this.listeners.slice()) { listener(payload); }
    }
    dispose() { this.listeners = []; }
}

/** Run compiled TypeScript in its own context; a require outside `allowed` throws. */
function load(code, filename, allowed) {
    const module = { exports: {} };
    const require = name => {
        if (!Object.hasOwn(allowed, name)) { throw new Error(`unexpected require from ${path.basename(filename)}: ${name}`); }
        return allowed[name];
    };
    const context = vm.createContext({
        exports: module.exports, module, require, console, process,
        setTimeout, clearTimeout, setInterval, clearInterval
    });
    vm.runInContext(code, context, { filename });
    return { exports: module.exports, context };
}

function loadClient() {
    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = WS_OPEN;
    const vscode = {
        EventEmitter: RecordingEventEmitter,
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            showErrorMessage: () => Promise.resolve(undefined)
        },
        // autoConnect=false: a failed send must not arm a real 5s reconnect timer, which would
        // hold the node:test child open. No workspaceFolders: the STATE_SNAPSHOT path check is skipped.
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };
    const { exports, context } = load(CLIENT_JS, CLIENT_PATH, {
        vscode, ws: StubWebSocket,
        child_process: { spawn: () => { throw new Error('unexpected spawn'); } },
        fs, path, net
    });
    const client = new exports.MoeDaemonClient('extension');
    const errors = [];
    client.onError(payload => errors.push(jsonCopy(payload)));
    // The client's `err instanceof Error` check compares against the vm realm's own Error.
    const VmError = vm.runInContext('Error', context);

    /** Install a connected fake socket; it records the frame BEFORE any injected failure. */
    function connectSocket(sendImpl) {
        const sent = [];
        client['ws'] = {
            readyState: WS_OPEN,
            send: frame => { sent.push(frame); if (sendImpl) { sendImpl(frame); } },
            close() {}
        };
        client['_connectionState'] = 'connected';
        return sent;
    }
    const deliver = frame => client['handleMessage'](JSON.stringify(frame));
    return { client, errors, VmError, connectSocket, deliver };
}

/** Every frame the socket was handed, JSON-parsed in the test realm. */
const frames = sent => sent.map(text => JSON.parse(text));

function onlyFrame(sent) {
    assert.equal(sent.length, 1, `expected exactly one outbound frame, got ${sent.length}`);
    return JSON.parse(sent[0]);
}

function withClient(body) {
    const h = loadClient();
    try { body(h); } finally { h.client.dispose(); }
}

// =============================================================================
// A: RELEASE_TASK (outbound), shaped like JetBrains MoeCommandSender.releaseTask
// =============================================================================

test('A1: releaseTask sends exactly one RELEASE_TASK frame carrying taskId and reason', () => {
    withClient(h => {
        const sent = h.connectSocket();
        assert.equal(h.client.releaseTask('t1', 'Released from board'), true);
        assert.deepStrictEqual(onlyFrame(sent), {
            type: 'RELEASE_TASK',
            payload: { taskId: 't1', reason: 'Released from board' }
        });
    });
});

test('A2: a blank or missing reason is left off the wire, a padded reason goes verbatim', () => {
    for (const blank of [undefined, null, '', '   ', '\t\n ']) {
        withClient(h => {
            const sent = h.connectSocket();
            assert.equal(h.client.releaseTask('t1', blank), true);
            const frame = onlyFrame(sent);
            assert.deepStrictEqual(frame, { type: 'RELEASE_TASK', payload: { taskId: 't1' } });
            assert.equal(Object.hasOwn(frame.payload, 'reason'), false, `blank ${JSON.stringify(blank)} must omit the reason key`);
        });
    }
    withClient(h => {
        const sent = h.connectSocket();
        assert.equal(h.client.releaseTask('t1'), true);
        assert.deepStrictEqual(onlyFrame(sent), { type: 'RELEASE_TASK', payload: { taskId: 't1' } });
    });
    // JetBrains sends a non-blank reason untrimmed; the daemon does the trimming.
    withClient(h => {
        const sent = h.connectSocket();
        assert.equal(h.client.releaseTask('t1', '  keep  '), true);
        assert.deepStrictEqual(onlyFrame(sent), { type: 'RELEASE_TASK', payload: { taskId: 't1', reason: '  keep  ' } });
    });
});

test('A3: releaseTask returns false and sends nothing while the client is not connected', () => {
    withClient(h => {
        const sent = h.connectSocket();
        h.client['_connectionState'] = 'disconnected';
        assert.equal(h.client.releaseTask('t1', 'why'), false);
        assert.deepStrictEqual(sent, []);
    });
    withClient(h => {
        const sent = h.connectSocket();
        h.client['ws'] = undefined;
        assert.equal(h.client.releaseTask('t1', 'why'), false);
        assert.deepStrictEqual(sent, []);
    });
    withClient(h => {
        const sent = h.connectSocket();
        h.client['ws'].readyState = 3;
        assert.equal(h.client.releaseTask('t1', 'why'), false);
        assert.deepStrictEqual(sent, []);
    });
});

test('A4: a throwing socket makes releaseTask return false and report the failure through onError', () => {
    withClient(h => {
        const sent = h.connectSocket(() => { throw new h.VmError('socket is gone'); });
        assert.equal(h.client.releaseTask('t1', 'why'), false);
        assert.equal(sent.length, 1, 'the frame reached the socket before it threw');
        assert.deepStrictEqual(h.errors, [{ operation: 'RELEASE_TASK', message: 'socket is gone' }]);
    });
});

// =============================================================================
// B: CHANNEL_DELETED (inbound), through the real ChatViewProvider
// =============================================================================

const CHAN_G = { id: 'chan-g', name: 'general', type: 'general', linkedEntityId: null, createdAt: '2026-01-01T00:00:00.000Z' };
const CHAN_X = { id: 'chan-x', name: 'x', type: 'custom', linkedEntityId: null, createdAt: '2026-01-02T00:00:00.000Z' };
const snapshot = channels => ({
    tasks: [], epics: [], workers: [], teams: [], proposals: [], decisions: [], channels: jsonCopy(channels)
});

/** A connected client plus the real provider, past the real 'ready' handshake. */
function setup({ withSnapshot }) {
    const h = loadClient();
    h.connectSocket();
    if (withSnapshot) { h.deliver({ type: 'STATE_SNAPSHOT', payload: snapshot([CHAN_G, CHAN_X]) }); }

    const providerVscode = {
        Uri: { joinPath: () => ({}) },
        window: { showInformationMessage: () => Promise.resolve(undefined) },
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };
    const { exports } = load(PROVIDER_JS, PROVIDER_PATH, { vscode: providerVscode, path });
    const provider = new exports.ChatViewProvider({}, h.client);

    const posts = [];
    let onMessage;
    const noop = () => ({ dispose() {} });
    provider.resolveWebviewView({
        visible: true,
        onDidDispose: noop,
        onDidChangeVisibility: noop,
        webview: {
            cspSource: '',
            asWebviewUri: () => 'chat.js',
            postMessage: message => { posts.push(jsonCopy(message)); return Promise.resolve(true); },
            onDidReceiveMessage: handler => { onMessage = handler; return { dispose() {} }; }
        }
    });
    onMessage({ type: 'ready' });
    posts.length = 0; // keep only what a later frame causes
    return {
        ...h, posts,
        // JSON copy: an array the client built carries the vm realm's prototype.
        channelIds: () => jsonCopy(h.client.currentState?.channels.map(c => c.id)),
        dispose: () => { provider.dispose(); h.client.dispose(); }
    };
}

function withProvider(options, body) {
    const h = setup(options);
    try { body(h); } finally { h.dispose(); }
}

test('B1: CHANNEL_DELETED prunes the cache first, tells the chat view once, and a repeat is a no-op', () => {
    withProvider({ withSnapshot: true }, h => {
        assert.deepStrictEqual(h.channelIds(), ['chan-g', 'chan-x']);
        h.deliver({ type: 'CHANNEL_DELETED', payload: CHAN_X });
        assert.deepStrictEqual(h.channelIds(), ['chan-g']);
        assert.deepStrictEqual(h.posts, [{ type: 'updateChannels', channels: [CHAN_G] }]);

        h.deliver({ type: 'CHANNEL_DELETED', payload: CHAN_X });
        assert.deepStrictEqual(h.channelIds(), ['chan-g']);
        assert.equal(h.posts.length, 1, 'a repeated frame posts nothing more');
    });
});

test('B1b: the cache is already pruned when the chat view is told', () => {
    withClient(h => {
        h.connectSocket();
        h.deliver({ type: 'STATE_SNAPSHOT', payload: snapshot([CHAN_G, CHAN_X]) });
        const seenAtFire = [];
        h.client.onChannelsReceived(list => seenAtFire.push({
            payload: jsonCopy(list).map(c => c.id),
            cache: jsonCopy(h.client.currentState.channels.map(c => c.id))
        }));
        h.deliver({ type: 'CHANNEL_DELETED', payload: CHAN_X });
        assert.deepStrictEqual(seenAtFire, [{ payload: ['chan-g'], cache: ['chan-g'] }]);
    });
});

test('B2: an unknown channel id changes nothing and posts nothing', () => {
    withProvider({ withSnapshot: true }, h => {
        const before = JSON.stringify(h.client.currentState.channels);
        h.deliver({ type: 'CHANNEL_DELETED', payload: { ...CHAN_X, id: 'chan-nope' } });
        assert.equal(JSON.stringify(h.client.currentState.channels), before);
        assert.deepStrictEqual(h.posts, []);
    });
});

test('B3: malformed payloads and a missing snapshot are silent no-ops that never throw', () => {
    withProvider({ withSnapshot: true }, h => {
        const before = JSON.stringify(h.client.currentState.channels);
        for (const payload of [null, {}, { id: 42 }, 'chan-x', []]) {
            assert.doesNotThrow(() => h.deliver({ type: 'CHANNEL_DELETED', payload }));
        }
        assert.doesNotThrow(() => h.deliver({ type: 'CHANNEL_DELETED' }));
        assert.equal(JSON.stringify(h.client.currentState.channels), before);
        assert.deepStrictEqual(h.posts, []);
    });
    withProvider({ withSnapshot: false }, h => {
        assert.equal(h.client.currentState, undefined);
        assert.doesNotThrow(() => h.deliver({ type: 'CHANNEL_DELETED', payload: CHAN_X }));
        assert.equal(h.client.currentState, undefined);
        assert.deepStrictEqual(h.posts, []);
    });
    withProvider({ withSnapshot: false }, h => {
        // A snapshot that carries no channel list at all.
        h.deliver({ type: 'STATE_SNAPSHOT', payload: { tasks: [], epics: [], workers: [], teams: [], proposals: [], decisions: [] } });
        h.posts.length = 0;
        assert.doesNotThrow(() => h.deliver({ type: 'CHANNEL_DELETED', payload: CHAN_X }));
        assert.equal(h.client.currentState.channels, undefined);
        assert.deepStrictEqual(h.posts, []);
    });
});

// =============================================================================
// C: the raw media/chat.js page script
// =============================================================================

const CHAN_Y = { ...CHAN_X, id: 'chan-y', name: 'y' };

/** One generic DOM element: records listeners and children, accepts every property write. */
function makeElement() {
    const listeners = {};
    const children = [];
    let text = '';
    const el = {
        dataset: {}, style: {}, className: '', value: '', disabled: false, children, listeners,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        appendChild(child) { children.push(child); return child; },
        querySelector: () => null,
        querySelectorAll: () => [],
        remove() {}, scrollTo() {}, focus() {}
    };
    // Like the DOM, assigning textContent replaces every child.
    Object.defineProperty(el, 'textContent', {
        get: () => text,
        set: value => { text = String(value); children.length = 0; }
    });
    return el;
}

/** Run the unmodified page script in a fresh realm and hand back what the test may observe. */
function loadPage() {
    const elements = new Map();
    const tabs = [];
    const stateWrites = [];
    const posts = [];
    const tabStrip = makeElement();
    tabStrip.appendChild = tab => { tabs.push(tab); return tab; };
    // Any property write to the tab strip is the page clearing it before it renders again, so
    // "tabs appended since the last write" are exactly the tabs on screen. The test never names
    // the written property.
    elements.set('channelTabs', new Proxy(tabStrip, { set: () => { tabs.length = 0; return true; } }));
    const byId = id => {
        if (!elements.has(id)) { elements.set(id, makeElement()); }
        return elements.get(id);
    };
    let onMessage;
    const context = vm.createContext({
        console, setTimeout, clearTimeout,
        acquireVsCodeApi: () => ({
            getState: () => undefined,
            setState: state => { stateWrites.push(jsonCopy(state)); },
            postMessage: message => { posts.push(jsonCopy(message)); }
        }),
        document: { getElementById: byId, createElement: () => makeElement() },
        window: {
            addEventListener: (type, handler) => { if (type === 'message') { onMessage = handler; } }
        }
    });
    vm.runInContext(PAGE_JS, context, { filename: PAGE_PATH });
    assert.equal(typeof onMessage, 'function', 'media/chat.js registered no message handler');

    const selectPosts = () => posts.filter(p => p.type === 'selectChannel');
    return {
        posts, stateWrites, selectPosts, byId,
        updateChannels: channels => onMessage({ data: { type: 'updateChannels', channels } }),
        send: data => onMessage({ data }),
        selectedInState: () => stateWrites.at(-1).currentChannel,
        activeTabs: () => tabs.filter(t => t.className.includes('active')).length,
        /** Click the tab at `index` (tab order is general, epic, task, custom, then list order). */
        clickTab: index => { for (const fn of tabs[index].listeners.click) { fn(); } },
        /** The channel behind every tab on screen. Clicks each one, so call it LAST. */
        listedIds: () => {
            const from = selectPosts().length;
            for (const tab of tabs.slice()) { for (const fn of tab.listeners.click) { fn(); } }
            return selectPosts().slice(from).map(p => p.channel);
        }
    };
}

test('C1: an update without the selected channel leaves it neither listed nor selected, and falls back to the first one', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G, CHAN_X]);
    assert.equal(page.selectedInState(), 'chan-g', 'the first channel is auto-selected');
    page.clickTab(1);
    assert.equal(page.selectedInState(), 'chan-x');

    page.updateChannels([CHAN_G]);
    assert.equal(page.selectedInState(), 'chan-g', 'the persisted selection fell back to the remaining channel');
    assert.equal(page.selectPosts().at(-1).channel, 'chan-g', 'the extension is asked for the fallback channel');
    assert.equal(page.activeTabs(), 1);
    assert.deepStrictEqual(page.listedIds(), ['chan-g']);
});

test('C2: an update that empties the list drops the selection and returns the page to its no-channel state', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G, CHAN_X]);
    page.clickTab(1);
    page.send({ type: 'loadPins', channel: 'chan-x', pins: [{ messageId: 'msg-0123456789', done: false }] });
    assert.equal(page.byId('pinnedSection').style.display, '', 'the deleted channel had a visible pinned strip');
    page.send({
        type: 'loadMessages', channel: 'chan-x',
        messages: [{ id: 'm1', sender: 'human', content: 'hello', timestamp: '2026-01-02T00:00:00.000Z' }]
    });
    assert.equal(page.byId('messages').children.length, 1, 'the deleted channel had a rendered message');
    const selectsBefore = page.selectPosts().length;

    page.updateChannels([]);
    assert.equal(page.byId('pinnedSection').style.display, 'none', 'the dead channel\'s pins are hidden');
    assert.equal(page.selectedInState(), null);
    assert.equal(page.selectPosts().length, selectsBefore, 'nothing is selected after the update');
    assert.equal(page.activeTabs(), 0);
    assert.equal(page.byId('chatInput').disabled, true);
    assert.equal(page.byId('sendBtn').disabled, true);
    const shown = page.byId('messages').children;
    assert.equal(shown.length, 1);
    assert.equal(shown[0].className, 'empty-state');
    assert.equal(shown[0].textContent, 'Select a channel to start chatting');
    assert.deepStrictEqual(page.listedIds(), []);
});

test('C3: a selection that is still listed is left alone and posts no extra selectChannel', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G, CHAN_X]);
    page.clickTab(1);
    const selectsBefore = page.selectPosts().length;

    page.updateChannels([CHAN_G, CHAN_X, CHAN_Y]);
    assert.equal(page.selectPosts().length, selectsBefore);
    assert.equal(page.selectedInState(), 'chan-x');
    assert.equal(page.byId('chatInput').disabled, false);
    assert.equal(page.activeTabs(), 1);
    assert.deepStrictEqual(page.listedIds(), ['chan-g', 'chan-x', 'chan-y']);
});

test('C4: an updateChannels message with no list degrades to the no-channel state instead of throwing', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G, CHAN_X]);
    page.clickTab(1);
    assert.doesNotThrow(() => page.send({ type: 'updateChannels' }));
    assert.equal(page.selectedInState(), null);
    assert.equal(page.byId('chatInput').disabled, true);
    assert.deepStrictEqual(page.listedIds(), []);
});

// =============================================================================
// D: chat.js channel auto-selection, JetBrains ChatChannelSelectionTest cases (b) to (f)
// =============================================================================

// ChatChannelSelectionTest's fixtures. A 'role' channel renders in the custom tab group.
const SEL_GENERAL = { ...CHAN_G, id: 'chan-general', name: 'general' };
const SEL_GENERAL_2 = { ...CHAN_G, id: 'chan-general-2', name: 'general2' };
const SEL_ZETA = { ...CHAN_X, id: 'chan-zeta', name: 'zeta' };
const SEL_ALPHA = { ...CHAN_X, id: 'chan-alpha', name: 'alpha', type: 'role' };
// Custom and listed last, so it is always the last tab on screen.
const SEL_GONE = { ...CHAN_X, id: 'chan-deleted', name: 'deleted' };

/** A page whose selection is a channel that the next update will no longer list. */
function pageSelectingGone(list) {
    const page = loadPage();
    page.updateChannels([...list, SEL_GONE]);
    page.clickTab(list.length);
    assert.equal(page.selectedInState(), 'chan-deleted', 'setup: the doomed channel is selected');
    return page;
}

test('D1 (b): a gone selection falls back to the general-type channel even when another is listed first', () => {
    const page = pageSelectingGone([SEL_ZETA, SEL_GENERAL]);
    page.updateChannels([SEL_ZETA, SEL_GENERAL]);
    assert.equal(page.selectedInState(), 'chan-general');
    assert.equal(page.selectPosts().at(-1).channel, 'chan-general');
    assert.equal(page.activeTabs(), 1);
});

test('D2 (c): a gone selection with no general-type channel falls back to the first in list order', () => {
    const page = pageSelectingGone([SEL_ZETA, SEL_ALPHA]);
    page.updateChannels([SEL_ZETA, SEL_ALPHA]);
    assert.equal(page.selectedInState(), 'chan-zeta');
    assert.equal(page.selectPosts().at(-1).channel, 'chan-zeta');
});

test('D3 (d): with no selection, the first update picks the general-type channel, else the first listed', () => {
    let page = loadPage();
    page.updateChannels([SEL_ZETA, SEL_GENERAL]);
    assert.equal(page.selectedInState(), 'chan-general');
    assert.deepStrictEqual(page.selectPosts().map(p => p.channel), ['chan-general']);
    page = loadPage();
    page.updateChannels([SEL_ZETA, SEL_ALPHA]);
    assert.deepStrictEqual(page.selectPosts().map(p => p.channel), ['chan-zeta']);
});

test('D4 (e): an empty list selects nothing, on first load and after a selection', () => {
    let page = loadPage();
    page.updateChannels([]);
    assert.deepStrictEqual(page.selectPosts(), []);
    assert.equal(page.activeTabs(), 0);
    page = loadPage();
    page.updateChannels([SEL_GENERAL]);
    page.updateChannels([]);
    assert.equal(page.selectedInState(), null);
    assert.equal(page.selectPosts().length, 1, 'only the first update selected anything');
});

test('D5 (f): of two general-type channels the first listed wins', () => {
    let page = loadPage();
    page.updateChannels([SEL_ZETA, SEL_GENERAL, SEL_GENERAL_2]);
    assert.equal(page.selectedInState(), 'chan-general');
    page = pageSelectingGone([SEL_ZETA, SEL_GENERAL_2, SEL_GENERAL]);
    page.updateChannels([SEL_ZETA, SEL_GENERAL_2, SEL_GENERAL]);
    assert.equal(page.selectedInState(), 'chan-general-2');
});

// =============================================================================
// E: CHANNEL_CREATED (inbound) replaces by id, as JetBrains MoeMessageDispatcher does
// =============================================================================

test('E1: a repeated CHANNEL_CREATED leaves one cache entry, and a known id takes the latest payload and moves last', () => {
    withProvider({ withSnapshot: true }, h => {
        h.deliver({ type: 'CHANNEL_CREATED', payload: CHAN_Y });
        h.deliver({ type: 'CHANNEL_CREATED', payload: CHAN_Y });
        assert.deepStrictEqual(h.channelIds(), ['chan-g', 'chan-x', 'chan-y']);
        const renamed = { ...CHAN_X, name: 'x2' };
        h.deliver({ type: 'CHANNEL_CREATED', payload: renamed });
        assert.deepStrictEqual(h.channelIds(), ['chan-g', 'chan-y', 'chan-x']);
        assert.deepStrictEqual(jsonCopy(h.client.currentState.channels).at(-1), renamed);
        assert.deepStrictEqual(h.posts, [
            { type: 'channelCreated', channel: CHAN_Y },
            { type: 'channelCreated', channel: CHAN_Y },
            { type: 'channelCreated', channel: renamed }
        ], 'one channelCreated post per frame, and no updateChannels');
    });
});

test('E1b: the cache already holds the new channel, once, when listeners are told', () => {
    withClient(h => {
        h.connectSocket();
        h.deliver({ type: 'STATE_SNAPSHOT', payload: snapshot([CHAN_G, CHAN_X]) });
        const seenAtFire = [];
        h.client.onChannelCreated(() => seenAtFire.push(jsonCopy(h.client.currentState.channels.map(c => c.id))));
        h.deliver({ type: 'CHANNEL_CREATED', payload: CHAN_Y });
        h.deliver({ type: 'CHANNEL_CREATED', payload: CHAN_Y });
        assert.deepStrictEqual(seenAtFire, [['chan-g', 'chan-x', 'chan-y'], ['chan-g', 'chan-x', 'chan-y']]);
    });
});

test('E2: a repeated channelCreated lists the channel once in chat.js, and a known id moves last', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G, CHAN_X]);
    page.send({ type: 'channelCreated', channel: CHAN_Y });
    page.send({ type: 'channelCreated', channel: CHAN_Y });
    page.send({ type: 'channelCreated', channel: CHAN_X });
    assert.equal(page.selectedInState(), 'chan-g', 'a listed selection is kept');
    assert.deepStrictEqual(page.listedIds(), ['chan-g', 'chan-y', 'chan-x']);
});

test('E3: a channel created while nothing is selected is selected, and a later one leaves that selection alone', () => {
    const page = loadPage();
    page.updateChannels([]);
    page.send({ type: 'channelCreated', channel: CHAN_X });
    assert.deepStrictEqual(page.selectPosts().map(p => p.channel), ['chan-x'], 'the created channel is selected');
    assert.equal(page.selectedInState(), 'chan-x');
    assert.equal(page.byId('chatInput').disabled, false);
    page.send({ type: 'channelCreated', channel: CHAN_G });
    assert.deepStrictEqual(page.selectPosts().map(p => p.channel), ['chan-x']);
    assert.deepStrictEqual(page.listedIds(), ['chan-g', 'chan-x']);
});

test('E4: malformed CHANNEL_CREATED payloads are silent no-ops in the client and the page', () => {
    withProvider({ withSnapshot: true }, h => {
        const before = JSON.stringify(h.client.currentState.channels);
        for (const payload of [null, {}, { id: 42 }, 'chan-x', []]) {
            assert.doesNotThrow(() => h.deliver({ type: 'CHANNEL_CREATED', payload }));
        }
        assert.doesNotThrow(() => h.deliver({ type: 'CHANNEL_CREATED' }));
        assert.equal(JSON.stringify(h.client.currentState.channels), before);
        assert.deepStrictEqual(h.posts, []);
    });
    withProvider({ withSnapshot: false }, h => {
        assert.doesNotThrow(() => h.deliver({ type: 'CHANNEL_CREATED', payload: CHAN_Y }));
        assert.equal(h.client.currentState, undefined);
        // A snapshot that carries no channel list at all: the first created channel starts one.
        h.deliver({ type: 'STATE_SNAPSHOT', payload: { tasks: [], epics: [], workers: [], teams: [], proposals: [], decisions: [] } });
        h.deliver({ type: 'CHANNEL_CREATED', payload: CHAN_Y });
        assert.equal(JSON.stringify(h.client.currentState.channels), JSON.stringify([CHAN_Y]));
    });
    const page = loadPage();
    page.updateChannels([CHAN_G]);
    for (const channel of [undefined, null, {}, { id: 42 }]) {
        assert.doesNotThrow(() => page.send({ type: 'channelCreated', channel }));
    }
    assert.deepStrictEqual(page.listedIds(), ['chan-g']);
});

'use strict';

// The chat view asks for decisions every time the daemon connection opens, and
// when it becomes visible while connected, not only at the page's 'ready'
// (twin of the JetBrains fix 6fe1e5ae; task-f8022395). The daemon sends
// DECISIONS only in reply to GET_DECISIONS, so a page that was ready before
// the connection opened, or that lived through an outage, otherwise shows open
// decisions with no Approve/Reject card.
// Runs the PRODUCTION MoeDaemonClient and ChatViewProvider, transpiled under
// node:vm the way tests/wire-parity.test.cjs loads them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const CLIENT_PATH = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const PROVIDER_PATH = path.join(__dirname, '../src/providers/ChatViewProvider.ts');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const WS_OPEN = 1;
const plain = value => JSON.parse(JSON.stringify(value));

class RecordingEventEmitter {
    constructor() {
        this.listeners = [];
        this.event = listener => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
        };
    }
    fire(payload) { for (const listener of this.listeners.slice()) { listener(payload); } }
    dispose() { this.listeners = []; }
}

function load(code, filename, allowed) {
    const module = { exports: {} };
    const require = name => {
        if (!Object.hasOwn(allowed, name)) { throw new Error(`unexpected require from ${path.basename(filename)}: ${name}`); }
        return allowed[name];
    };
    const context = vm.createContext({ exports: module.exports, module, require, console, process, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(code, context, { filename });
    return module.exports;
}

/** The real client, still disconnected, and the real chat provider with a recording view. */
function setup() {
    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = WS_OPEN;
    const vscode = {
        EventEmitter: RecordingEventEmitter,
        window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showErrorMessage: () => Promise.resolve(undefined) },
        workspace: { getConfiguration: () => ({ get: () => false }) }
    };
    const clientExports = load(compile(CLIENT_PATH), CLIENT_PATH, {
        vscode, ws: StubWebSocket, child_process: { spawn: () => { throw new Error('unexpected spawn'); } }, fs, path, net
    });
    const client = new clientExports.MoeDaemonClient('extension');
    const providerExports = load(compile(PROVIDER_PATH), PROVIDER_PATH, {
        vscode: { Uri: { joinPath: () => ({}) }, window: { showInformationMessage: () => Promise.resolve(undefined) }, workspace: { getConfiguration: () => ({ get: () => false }) } },
        path
    });
    const provider = new providerExports.ChatViewProvider({}, client);
    let onMessage;
    let onVisibility;
    const posted = [];
    const view = {
        visible: true,
        onDidDispose: () => ({ dispose() {} }),
        onDidChangeVisibility: handler => { onVisibility = handler; return { dispose() {} }; },
        webview: {
            cspSource: '', asWebviewUri: () => 'chat.js',
            postMessage: message => { posted.push(plain(message)); return Promise.resolve(true); },
            onDidReceiveMessage: handler => { onMessage = handler; return { dispose() {} }; }
        }
    };
    provider.resolveWebviewView(view);
    const sent = [];
    const connect = () => {
        client['ws'] = { readyState: WS_OPEN, send: frame => sent.push(JSON.parse(frame).type), close() {} };
        client['setConnectionState']('connected');
    };
    return {
        client, sent, posted, connect,
        disconnect: () => client['setConnectionState']('disconnected'),
        ready: () => onMessage({ type: 'ready' }),
        reveal: () => { view.visible = true; onVisibility(); },
        reply: frame => client['handleMessage'](JSON.stringify(frame)),
        dispose: () => { provider.dispose(); client.dispose(); }
    };
}

const decisionsSent = h => h.sent.filter(type => type === 'GET_DECISIONS').length;

test('CH1: a page that was ready before the connection opened gets GET_DECISIONS with GET_CHANNELS once it opens', () => {
    const h = setup();
    try {
        h.ready();
        assert.deepEqual(h.sent, [], 'nothing can be sent while disconnected');
        h.connect();
        assert.ok(h.sent.includes('GET_CHANNELS'), 'frames: ' + JSON.stringify(h.sent));
        assert.ok(decisionsSent(h) >= 1, 'frames: ' + JSON.stringify(h.sent));
    } finally { h.dispose(); }
});

test('CH2: a reconnect asks again, and its DECISIONS reply reaches the page as loadDecisions', () => {
    const h = setup();
    try {
        h.connect();
        h.ready();
        h.disconnect();
        h.sent.length = 0;
        h.posted.length = 0;
        h.connect();
        assert.ok(decisionsSent(h) >= 1, 'frames after reconnect: ' + JSON.stringify(h.sent));
        const decision = { id: 'dec-1', status: 'PENDING', channel: 'chan-1', messageId: 'msg-1', title: 'Pick one' };
        h.reply({ type: 'DECISIONS', payload: { decisions: [decision] } });
        assert.deepEqual(h.posted.filter(m => m.type === 'loadDecisions'), [{ type: 'loadDecisions', decisions: [decision] }]);
    } finally { h.dispose(); }
});

test('CH3: revealing the view while connected asks for decisions with the channels', () => {
    const h = setup();
    try {
        h.connect();
        h.ready();
        h.sent.length = 0;
        h.reveal();
        assert.ok(h.sent.includes('GET_CHANNELS'), 'frames: ' + JSON.stringify(h.sent));
        assert.ok(decisionsSent(h) >= 1, 'frames: ' + JSON.stringify(h.sent));
    } finally { h.dispose(); }
});

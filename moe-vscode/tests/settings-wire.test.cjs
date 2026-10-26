'use strict';

// Settings save wire pin: the form's wire defaults must never weaken strict settings.
// Runs the REAL MoeDaemonClient, SettingsPanel and the RAW media/settings.js, so every
// assertion crosses page -> panel -> client -> socket frame. The page realm is built
// only from the HTML the panel emitted (an undeclared id resolves to null). Each test
// gets fresh vm contexts because SettingsPanel.currentPanel is static.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const CLIENT_PATH = path.join(__dirname, '../src/services/MoeDaemonClient.ts');
const PANEL_PATH = path.join(__dirname, '../src/panels/SettingsPanel.ts');
const PAGE_PATH = path.join(__dirname, '../media/settings.js');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const [CLIENT_JS, PANEL_JS] = [CLIENT_PATH, PANEL_PATH].map(compile);
const PAGE_JS = fs.readFileSync(PAGE_PATH, 'utf8');

const FORM_KEYS = ['agentCommand', 'approvalMode', 'autoCreateBranch', 'branchPattern', 'commitPattern', 'speedModeDelayMs'];
const STORED = {
    approvalMode: 'CONTROL', speedModeDelayMs: 4500, agentCommand: 'my-agent --msg "a & b" --in <dir>',
    autoCreateBranch: false, branchPattern: 'moe/{taskId}-x', commitPattern: "feat({epicId}): don't {taskTitle}",
    executionProfile: 'observe', deliveryPolicy: 'local-branch', qualityGate: 'npm test', qualityGateScope: 'everyTask',
    consolidationBranch: 'moe/work-*', autoCommit: false, checkpointCommits: false, checkpointPush: false,
    commitBoardState: false, commitHooks: true, attribution: { undeclared: 'never', contested: 'skip' },
    taskSizing: { maxSteps: 6 }, appendOnlyFiles: ['CHANGELOG.md'], refusalCascadeAutoBacklog: false,
    enableAgentTeams: true, chatEnabled: false, chatMaxAgentHops: 2, columnLimits: { WORKING: 2 }
};

/** vscode.EventEmitter stand-in: the client only subscribes, fires and disposes. */
class FakeEmitter {
    constructor() { this.event = () => ({ dispose() {} }); }
    fire() {}
    dispose() {}
}

/** Run compiled TypeScript in its own context; a require outside `allowed` throws. */
function load(code, filename, allowed) {
    const module = { exports: {} };
    const require = name => {
        if (!Object.hasOwn(allowed, name)) { throw new Error(`unexpected require from ${path.basename(filename)}: ${name}`); }
        return allowed[name];
    };
    vm.runInContext(code, vm.createContext({ exports: module.exports, module, require, console, process, setTimeout, clearTimeout, setInterval, clearInterval }), { filename });
    return module.exports;
}

const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/&amp;/g, '&');

/** The elements a browser builds from the emitted HTML, with the page script running on them. */
function loadPage(html, postMessage) {
    const elements = new Map();
    for (const [tag] of html.matchAll(/<(?:input|select|button)\b[^>]*>/g)) {
        const id = /\bid="([^"]+)"/.exec(tag);
        if (!id) { continue; }
        const el = { id: id[1], clicks: [], addEventListener(type, fn) { if (type === 'click') { el.clicks.push(fn); } } };
        if (/\btype="checkbox"/.test(tag)) {
            el.checked = /\schecked(?=[\s/>=])/.test(tag);
        } else if (tag.startsWith('<select')) {
            const block = new RegExp(`<select[^>]*\\bid="${id[1]}"[^>]*>([\\s\\S]*?)</select>`).exec(html)[1];
            const options = [...block.matchAll(/<option\b([^>]*)>/g)].map(o => ({
                value: /\bvalue="([^"]*)"/.exec(o[1])[1], selected: /\sselected(?=[\s/>=]|$)/.test(o[1])
            }));
            el.value = (options.find(o => o.selected) || options[0]).value;
        } else {
            const value = /\bvalue="([^"]*)"/.exec(tag);
            el.value = value ? decode(value[1]) : '';
        }
        elements.set(el.id, el);
    }
    const document = { getElementById: id => elements.get(id) || null };
    vm.runInContext(PAGE_JS, vm.createContext({ acquireVsCodeApi: () => ({ postMessage }), document }), { filename: PAGE_PATH });
    const el = id => {
        if (!elements.has(id)) { throw new Error(`no element with id ${id} in the emitted HTML`); }
        return elements.get(id);
    };
    return { el, click: id => { for (const fn of el(id).clicks) { fn({ preventDefault() {} }); } } };
}

/** Open the real panel on a real client fed one STATE_SNAPSHOT; `settings` undefined means no project. */
function withSettingsPage(settings, body) {
    const seen = { frames: [], info: [], errors: [], disposes: 0, handler: undefined };
    let panel;
    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = 1;
    const vscode = {
        EventEmitter: FakeEmitter,
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') },
        workspace: { getConfiguration: () => ({ get: () => false }) }, // autoConnect off: no reconnect timer
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            showInformationMessage: message => { seen.info.push(message); return Promise.resolve(undefined); },
            showErrorMessage: message => { seen.errors.push(message); return Promise.resolve(undefined); },
            createWebviewPanel: () => {
                let onDispose;
                const webview = {
                    cspSource: 'vscode-webview://unit-test', asWebviewUri: uri => uri, html: '',
                    onDidReceiveMessage: handler => { seen.handler = handler; return { dispose() {} }; }
                };
                panel = {
                    webview, reveal() {}, onDidDispose: callback => { onDispose = callback; return { dispose() {} }; },
                    dispose() { seen.disposes++; if (onDispose) { onDispose(); } }
                };
                return panel;
            }
        }
    };
    const { MoeDaemonClient } = load(CLIENT_JS, CLIENT_PATH, {
        vscode, ws: StubWebSocket, fs, path, net, child_process: { spawn: () => { throw new Error('unexpected spawn'); } }
    });
    const { SettingsPanel } = load(PANEL_JS, PANEL_PATH, { vscode });

    const client = new MoeDaemonClient('extension');
    try {
        client['ws'] = { readyState: 1, send: frame => seen.frames.push(JSON.parse(frame)), close() {} };
        client['_connectionState'] = 'connected';
        const payload = { project: settings && { id: 'p', rootPath: '/p', settings }, tasks: [], epics: [] };
        client['handleMessage'](JSON.stringify({ type: 'STATE_SNAPSHOT', payload }));
        SettingsPanel.createOrShow('ext', client, client.currentState);
        body(loadPage(panel.webview.html, message => {
            if (typeof seen.handler !== 'function') { throw new Error('the panel registered no message handler'); }
            seen.handler(message);
        }), seen);
    } finally { client.dispose(); }
}

/** The single UPDATE_SETTINGS payload on the wire, which must carry exactly the six form keys. */
function savedPayload(seen) {
    assert.equal(seen.frames.length, 1, 'exactly one frame reached the socket');
    assert.equal(seen.frames[0].type, 'UPDATE_SETTINGS');
    const payload = seen.frames[0].payload;
    assert.deepEqual(Object.keys(payload).sort(), FORM_KEYS, 'no strict or unrelated key is invented or echoed');
    return payload;
}

test('S1: an unedited save writes back exactly the stored form values and nothing else', () => {
    withSettingsPage(STORED, (page, seen) => {
        page.click('saveBtn');
        const payload = savedPayload(seen);
        for (const key of FORM_KEYS) { assert.strictEqual(payload[key], STORED[key], key); }
        assert.deepEqual(seen.info, ['Settings saved.']);
        assert.deepEqual(seen.errors, []);
        assert.equal(seen.disposes, 1);
    });
});

for (const mode of ['CONTROL', 'SPEED', 'TURBO']) {
    test(`S2: an unedited save keeps the stored ${mode} mode`, () => {
        withSettingsPage({ ...STORED, approvalMode: mode }, (page, seen) => {
            page.click('saveBtn');
            assert.equal(savedPayload(seen).approvalMode, mode);
        });
    });
}

test('S3: with no project the form defaults are CONTROL and the six-key payload', () => {
    withSettingsPage(undefined, (page, seen) => {
        page.click('saveBtn');
        assert.deepEqual(savedPayload(seen), {
            approvalMode: 'CONTROL', speedModeDelayMs: 2000, agentCommand: 'claude', autoCreateBranch: true,
            branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'feat({epicId}): {taskTitle}'
        });
    });
});

test('S4: user edits reach the wire as typed, trimmed where the page trims', () => {
    withSettingsPage(STORED, (page, seen) => {
        page.el('approvalMode').value = 'SPEED';
        page.el('speedModeDelayMs').value = '3000';
        page.el('agentCommand').value = '  grok  ';
        page.el('autoCreateBranch').checked = true;
        page.el('branchPattern').value = '  moe/x/{taskId}  ';
        page.click('saveBtn');
        assert.deepEqual(savedPayload(seen), {
            approvalMode: 'SPEED', speedModeDelayMs: 3000, agentCommand: 'grok', autoCreateBranch: true,
            branchPattern: 'moe/x/{taskId}', commitPattern: STORED.commitPattern
        });
    });
});

for (const typed of ['', 'abc', '0']) {
    test(`S5: a delay of ${JSON.stringify(typed)} is sent as 2000, never 0, NaN or null`, () => {
        withSettingsPage(STORED, (page, seen) => {
            page.el('speedModeDelayMs').value = typed;
            page.click('saveBtn');
            assert.strictEqual(savedPayload(seen).speedModeDelayMs, 2000);
        });
    });
}

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

// Exactly what JetBrains' MoeCommandSender.updateSettings sends. The daemon still stores
// autoCreateBranch, branchPattern and commitPattern, but no launcher reads them, so VS Code
// neither edits nor sends them.
const FORM_KEYS = ['agentCommand', 'approvalMode', 'enableAgentTeams', 'speedModeDelayMs'];
const LEGACY_KEYS = ['autoCreateBranch', 'branchPattern', 'commitPattern'];
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
    const window = { addEventListener() {} }; // the page's live-settings listener; tests/settings-live.test.cjs drives it
    vm.runInContext(PAGE_JS, vm.createContext({ acquireVsCodeApi: () => ({ postMessage }), document, window }), { filename: PAGE_PATH });
    const el = id => {
        if (!elements.has(id)) { throw new Error(`no element with id ${id} in the emitted HTML`); }
        return elements.get(id);
    };
    return { el, click: id => { for (const fn of el(id).clicks) { fn({ preventDefault() {} }); } } };
}

/** Open the real panel on a real client fed one STATE_SNAPSHOT; `settings` undefined means no project. */
function withSettingsPage(settings, body) {
    const seen = { frames: [], posted: [], info: [], warnings: [], errors: [], disposes: 0, handler: undefined };
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
            showWarningMessage: message => { seen.warnings.push(message); return Promise.resolve(undefined); },
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
        seen.html = panel.webview.html;
        body(loadPage(panel.webview.html, message => {
            if (typeof seen.handler !== 'function') { throw new Error('the panel registered no message handler'); }
            seen.posted.push(JSON.parse(JSON.stringify(message)));
            seen.handler(message);
        }), seen, client);
    } finally { client.dispose(); }
}

/** The single UPDATE_SETTINGS payload on the wire, which must carry exactly the four form keys. */
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
        assert.deepEqual(seen.warnings, []);
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

test('S3: with no project the form defaults are CONTROL and the four-key payload', () => {
    withSettingsPage(undefined, (page, seen) => {
        page.click('saveBtn');
        assert.deepEqual(savedPayload(seen), {
            approvalMode: 'CONTROL', speedModeDelayMs: 2000, agentCommand: 'claude', enableAgentTeams: false
        });
    });
});

test('S4: user edits reach the wire as typed, trimmed where the page trims', () => {
    withSettingsPage(STORED, (page, seen) => {
        page.el('approvalMode').value = 'SPEED';
        page.el('speedModeDelayMs').value = '3000';
        page.el('agentCommand').value = '  grok  ';
        page.el('enableAgentTeams').checked = false;
        page.click('saveBtn');
        assert.deepEqual(savedPayload(seen), {
            approvalMode: 'SPEED', speedModeDelayMs: 3000, agentCommand: 'grok', enableAgentTeams: false
        });
    });
});

for (const [stored, shown] of [[true, true], [false, false], [undefined, false], ['true', false]]) {
    test(`S9: a stored enableAgentTeams of ${JSON.stringify(stored)} shows ${shown ? 'checked' : 'unchecked'}, saves as ${shown} and toggles to ${!shown}`, () => {
        withSettingsPage({ ...STORED, enableAgentTeams: stored }, (page, seen) => {
            assert.strictEqual(page.el('enableAgentTeams').checked, shown);
            page.click('saveBtn');
            assert.strictEqual(savedPayload(seen).enableAgentTeams, shown);
        });
        withSettingsPage({ ...STORED, enableAgentTeams: stored }, (page, seen) => {
            page.el('enableAgentTeams').checked = !shown;
            page.click('saveBtn');
            assert.strictEqual(savedPayload(seen).enableAgentTeams, !shown);
        });
    });
}

test('S10: the removed Git controls are not emitted and no save carries their keys', () => {
    withSettingsPage(STORED, (page, seen) => {
        for (const id of LEGACY_KEYS) {
            assert.ok(!seen.html.includes(`id="${id}"`), `${id} control is still emitted`);
            assert.throws(() => page.el(id), /no element with id/);
        }
        assert.ok(!seen.html.includes('<h2>Git</h2>'), 'the Git section is gone');
        page.click('saveBtn');
        const payload = savedPayload(seen);
        for (const key of LEGACY_KEYS) { assert.ok(!(key in payload), `${key} must never be sent`); }
        // The page itself posts only the four form keys, so the panel is not the sole guard.
        assert.deepEqual(seen.posted.map(message => Object.keys(message).sort()), [['type', ...FORM_KEYS].sort()]);
    });
});

test('S11: the panel builds the payload itself: extra message keys never reach the wire and enableAgentTeams must be exactly true', () => {
    withSettingsPage(STORED, (page, seen) => {
        seen.handler({
            type: 'save', approvalMode: 'TURBO', speedModeDelayMs: 1500, agentCommand: ' x ', enableAgentTeams: 'true',
            autoCreateBranch: true, branchPattern: 'p', commitPattern: 'c', qualityGate: 'rm -rf /'
        });
        assert.deepEqual(savedPayload(seen), { approvalMode: 'TURBO', speedModeDelayMs: 1500, agentCommand: 'x', enableAgentTeams: false });
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

test('S6: profile and evidence settings are never sent and survive the SETTINGS_UPDATED roundtrip', () => {
    const kept = {
        executionProfile: 'observe', deliveryPolicy: 'local-branch', checkEnvironments: [{ id: 'env-1', image: 'ubuntu-24.04' }], repairPolicy: { maxCodeRepairs: 2 },
        // The daemon still stores these; VS Code no longer edits or sends them.
        autoCreateBranch: true, branchPattern: 'moe/legacy/{taskId}', commitPattern: 'legacy: {taskTitle}'
    };
    withSettingsPage({ ...STORED, ...kept }, (page, seen, client) => {
        page.click('saveBtn');
        const payload = savedPayload(seen);
        client['handleMessage'](JSON.stringify({ type: 'SETTINGS_UPDATED', payload: { id: 'p', rootPath: '/p', settings: { ...STORED, ...kept, ...payload } } }));
        // The client parsed the frame in its own vm realm, so compare serialized values, not prototypes.
        const settings = client.currentState.project.settings;
        for (const key of Object.keys(kept)) { assert.equal(JSON.stringify(settings[key]), JSON.stringify(kept[key]), key); }
    });
});

const NOT_SAVED = 'Not connected to Moe daemon — settings were not saved.';

test('S7: a disconnected save warns, sends nothing, keeps the panel open, and a retry after reconnecting saves', () => {
    withSettingsPage(STORED, (page, seen, client) => {
        const socket = client['ws'];
        client.disconnect();
        page.click('saveBtn');
        assert.deepEqual(seen.frames, [], 'no frame reaches the socket while disconnected');
        assert.deepEqual(seen.warnings, [NOT_SAVED]);
        assert.deepEqual(seen.info, []);
        assert.deepEqual(seen.errors, []);
        assert.equal(seen.disposes, 0, 'the panel stays open');
        client['ws'] = socket;
        client['_connectionState'] = 'connected';
        page.click('saveBtn');
        savedPayload(seen);
        assert.deepEqual(seen.info, ['Settings saved.']);
        assert.deepEqual(seen.warnings, [NOT_SAVED], 'the retry adds no warning');
        assert.equal(seen.disposes, 1);
    });
});

test('S8: a save whose socket send throws warns, never claims success, and keeps the panel open', () => {
    withSettingsPage(STORED, (page, seen, client) => {
        client['ws'] = { readyState: 1, send() { throw new Error('socket hang up'); }, close() {} };
        page.click('saveBtn');
        assert.deepEqual(seen.warnings, [NOT_SAVED]);
        assert.deepEqual(seen.info, []);
        assert.deepEqual(seen.errors, []);
        assert.equal(seen.disposes, 0);
        assert.equal(client.connectionState, 'disconnected');
    });
});

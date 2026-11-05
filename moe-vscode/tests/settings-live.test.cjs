'use strict';

// Audit V9: an open Settings form follows settings changed elsewhere (JetBrains, an agent, another window), so Save
// never writes back a value the project no longer has. Runs the REAL MoeDaemonClient and SettingsPanel and the RAW
// media/settings.js; daemon frames go in through the client, the panel's posts reach the page, and Save is read off
// the socket. The harness is settings-wire.test.cjs's (tests share no helper module), with an event emitter that
// delivers, listeners by event type, and the read-only policy section.

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
const jsonCopy = value => JSON.parse(JSON.stringify(value));

const STORED = { approvalMode: 'CONTROL', speedModeDelayMs: 2000, agentCommand: 'claude', enableAgentTeams: false, qualityGate: 'npm test' };
const CHANGED = { approvalMode: 'TURBO', speedModeDelayMs: 4500, agentCommand: 'codex', enableAgentTeams: true, qualityGate: 'make check' };

/** vscode.EventEmitter stand-in that delivers, so the panel hears the client. */
class Emitter {
    constructor() {
        this.listeners = [];
        this.event = listener => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
        };
    }
    fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
    dispose() { this.listeners = []; }
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
    for (const [tag] of html.matchAll(/<(?:input|select|button|section)\b[^>]*>/g)) {
        const id = /\bid="([^"]+)"/.exec(tag);
        if (!id) { continue; }
        const el = { id: id[1], listeners: {}, addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); } };
        if (/\btype="checkbox"/.test(tag)) {
            el.checked = /\schecked(?=[\s/>=])/.test(tag);
        } else if (tag.startsWith('<section')) {
            el.innerHTML = new RegExp(`<section[^>]*\\bid="${id[1]}"[^>]*>([\\s\\S]*?)</section>`).exec(html)[1];
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
    let onMessage;
    const document = { getElementById: id => elements.get(id) || null };
    const window = { addEventListener: (type, fn) => { if (type === 'message') { onMessage = fn; } } };
    vm.runInContext(PAGE_JS, vm.createContext({ acquireVsCodeApi: () => ({ postMessage }), document, window }), { filename: PAGE_PATH });
    const el = id => {
        if (!elements.has(id)) { throw new Error(`no element with id ${id} in the emitted HTML`); }
        return elements.get(id);
    };
    const fire = (id, type) => { for (const fn of el(id).listeners[type] || []) { fn({ preventDefault() {} }); } };
    return {
        el,
        click: id => fire(id, 'click'),
        /** What a user's edit does: the new value, then the input and change events. */
        edit: (id, value) => {
            if (typeof value === 'boolean') { el(id).checked = value; } else { el(id).value = value; }
            fire(id, 'input');
            fire(id, 'change');
        },
        deliver: message => { if (onMessage) { onMessage({ data: jsonCopy(message) }); } },
        form: () => ({
            approvalMode: el('approvalMode').value, speedModeDelayMs: el('speedModeDelayMs').value,
            agentCommand: el('agentCommand').value, enableAgentTeams: el('enableAgentTeams').checked
        })
    };
}

/** Open the real panel on a real client fed one STATE_SNAPSHOT of `settings`. */
function withLiveSettings(settings, body) {
    const seen = { frames: [], toPage: [], disposes: 0, handler: undefined };
    let panel, page;
    function StubWebSocket() { throw new Error('these tests never open a real socket'); }
    StubWebSocket.OPEN = 1;
    const vscode = {
        EventEmitter: Emitter,
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') },
        workspace: { getConfiguration: () => ({ get: () => false }) }, // autoConnect off: no reconnect timer
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            showInformationMessage: () => Promise.resolve(undefined),
            showWarningMessage: () => Promise.resolve(undefined),
            showErrorMessage: () => Promise.resolve(undefined),
            createWebviewPanel: () => {
                let onDispose;
                const webview = {
                    cspSource: 'vscode-webview://unit-test', asWebviewUri: uri => uri, html: '',
                    onDidReceiveMessage: handler => { seen.handler = handler; return { dispose() {} }; },
                    postMessage: message => { seen.toPage.push(jsonCopy(message)); page?.deliver(message); return Promise.resolve(true); }
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
    const daemon = (type, payload) => client['handleMessage'](JSON.stringify({ type, payload }));
    const project = s => ({ id: 'p', rootPath: '/p', settings: s });
    try {
        client['ws'] = { readyState: 1, send: frame => seen.frames.push(JSON.parse(frame)), close() {} };
        client['_connectionState'] = 'connected';
        daemon('STATE_SNAPSHOT', { project: project(settings), tasks: [], epics: [] });
        SettingsPanel.createOrShow('ext', client, client.currentState);
        page = loadPage(panel.webview.html, message => {
            if (typeof seen.handler !== 'function') { throw new Error('the panel registered no message handler'); }
            seen.handler(message);
        });
        body({
            page, seen, client,
            settingsUpdated: s => daemon('SETTINGS_UPDATED', project(s)),
            snapshot: s => daemon('STATE_SNAPSHOT', { project: project(s), tasks: [], epics: [] }),
            /** The four keys Save put on the wire. */
            saved: () => {
                const frames = seen.frames.filter(frame => frame.type === 'UPDATE_SETTINGS');
                assert.equal(frames.length, 1, 'one UPDATE_SETTINGS frame');
                return frames[0].payload;
            }
        });
    } finally { client.dispose(); }
}

const FORM_OF = s => ({ approvalMode: s.approvalMode, speedModeDelayMs: String(s.speedModeDelayMs), agentCommand: s.agentCommand, enableAgentTeams: s.enableAgentTeams });
const WIRE_OF = s => ({ approvalMode: s.approvalMode, speedModeDelayMs: s.speedModeDelayMs, agentCommand: s.agentCommand, enableAgentTeams: s.enableAgentTeams });

test('L1 SETTINGS_UPDATED reaches the open form, so an unedited Save writes the new values back, not the old ones', () => {
    withLiveSettings(STORED, h => {
        assert.deepEqual(h.page.form(), FORM_OF(STORED), 'setup: the form shows the stored settings');
        h.settingsUpdated(CHANGED);
        assert.deepEqual(h.page.form(), FORM_OF(CHANGED));
        h.page.click('saveBtn');
        assert.deepEqual(h.saved(), WIRE_OF(CHANGED));
    });
});

test('L2 a field the user edited keeps the user value; the others follow the change', () => {
    withLiveSettings(STORED, h => {
        h.page.edit('agentCommand', 'grok');
        h.page.edit('enableAgentTeams', true);
        h.settingsUpdated(CHANGED);
        assert.deepEqual(h.page.form(), { ...FORM_OF(CHANGED), agentCommand: 'grok', enableAgentTeams: true });
        h.settingsUpdated({ ...CHANGED, enableAgentTeams: false });
        assert.equal(h.page.el('enableAgentTeams').checked, true, 'still the user value');
        h.page.click('saveBtn');
        assert.deepEqual(h.saved(), { ...WIRE_OF(CHANGED), agentCommand: 'grok', enableAgentTeams: true });
    });
});

test('L3 a new STATE_SNAPSHOT updates the form and the read-only landing policy', () => {
    withLiveSettings(STORED, h => {
        assert.ok(h.page.el('landingPolicy').innerHTML.includes('npm test'), 'setup: the policy shows the stored gate');
        h.snapshot(CHANGED);
        assert.deepEqual(h.page.form(), FORM_OF(CHANGED));
        const policy = h.page.el('landingPolicy').innerHTML;
        assert.ok(policy.includes('make check') && !policy.includes('npm test'), policy);
    });
});

test('L4 a state change that leaves the settings as shown posts nothing to the page', () => {
    withLiveSettings(STORED, h => {
        h.snapshot(STORED);
        h.settingsUpdated(STORED);
        assert.deepEqual(h.seen.toPage, []);
        h.settingsUpdated(CHANGED);
        h.snapshot(CHANGED);
        assert.equal(h.seen.toPage.length, 1, 'one post per change');
    });
});

test('L5 a closed panel stops listening: later changes post nothing', () => {
    withLiveSettings(STORED, h => {
        h.page.click('cancelBtn');
        assert.equal(h.seen.disposes, 1);
        h.settingsUpdated(CHANGED);
        assert.deepEqual(h.seen.toPage, []);
    });
});

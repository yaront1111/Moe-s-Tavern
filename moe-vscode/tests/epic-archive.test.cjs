'use strict';

// VS Code epic detail panel: an Archived pick no longer rides along with the field edits (JetBrains 19af5ca6) and no
// save claims success before the daemon answers. Real client + panel under node:vm; texts read from MoeBundle.properties.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const transpile = relative => ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
const CLIENT_SOURCE = transpile('src/services/MoeDaemonClient.ts');
const PANEL_SOURCE = transpile('src/panels/EpicDetailPanel.ts');
const BUNDLE = fs.readFileSync(path.join(__dirname, '../../moe-jetbrains/src/main/resources/messages/MoeBundle.properties'), 'utf8');

function bundleText(key) {
    const line = BUNDLE.split(/\r?\n/).find(l => l.startsWith(`${key}=`));
    assert.ok(line, `MoeBundle.properties has no "${key}"`);
    return line.slice(key.length + 1).replace(/\\n/g, '\n');
}
const ARCHIVE_TITLE = bundleText('moe.message.archiveEpicTitle');
const CONFIRM = bundleText('moe.message.archiveEpic');
const IN_FLIGHT = bundleText('moe.message.archiveEpicInFlight');
// Independent of the production substitution: split the template on its placeholders.
const fill = (template, a, b) => template.split(/(\{[01]\})/).map(p => (p === '{0}' ? a : p === '{1}' ? b : p)).join('');

// The daemon's verbatim refusal of an UPDATE_EPIC to ARCHIVED while a task is in flight.
const REFUSAL = { type: 'ERROR', message: '[NOT_ALLOWED] archive epic not allowed: Epic "epic-1" has 1 in-flight task(s) (task-working:WORKING). Move them to BACKLOG first via moe.set_task_status (release_task keeps a WORKING task in the WORKING column, so releasing does not make it archivable).', operation: 'UPDATE_EPIC', code: -32003, codeName: 'NOT_ALLOWED', context: { epicId: 'epic-1' } };
const FIELDS_FRAME = '{"type":"UPDATE_EPIC","payload":{"epicId":"epic-1","updates":{"title":"Typed title","description":"new desc","architectureNotes":"new notes","epicRails":["rail one"]}}}';
const STATUS_FRAME = '{"type":"UPDATE_EPIC","payload":{"epicId":"epic-1","updates":{"status":"ARCHIVED"}}}';
const oneFrame = status => `${FIELDS_FRAME.slice(0, -3)},"status":"${status}"}}}`;
const WAITING = ['Still waiting for the Moe daemon to answer the last save of epic "Typed title".'];
const LOST = 'Lost the connection to the Moe daemon before it confirmed the save of epic "Typed title". Your edits are still in this panel.';
const notSaved = message => [[`Epic "Typed title" was not saved: ${message}`]];

const EPIC = { id: 'epic-1', projectId: 'p', title: 'Epic {1} $& <b>', description: 'old', architectureNotes: '', epicRails: [], status: 'ACTIVE', order: 3, createdAt: 't', updatedAt: 't' };
const task = (id, status, epicId = 'epic-1') => ({ id, epicId, title: `T-${id}`, description: '', definitionOfDone: [], status, priority: 'MEDIUM', implementationPlan: [], comments: [], reopenCount: 0 });
const subscription = () => ({ dispose() {} });

class RecordingEventEmitter {
    listeners = [];
    event = listener => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } }; };
    fire(payload) { for (const listener of this.listeners.slice()) { listener(payload); } }
    dispose() { this.listeners = []; }
}

// Runs a transpiled module that may require only the given dependencies.
function loadModule(source, filename, dependencies, globals) {
    const module = { exports: {} };
    const require = name => {
        if (Object.prototype.hasOwnProperty.call(dependencies, name)) { return dependencies[name]; }
        throw new Error(`unexpected require from ${path.basename(filename)}: ${name}`);
    };
    vm.runInContext(source, vm.createContext({ exports: module.exports, module, console, require, ...globals }), { filename });
    return module.exports;
}

/** A fresh client and panel (a new module per call: the panel keeps a static map) on a cache of `epic` and `tasks`. */
function open({ epic = EPIC, tasks = [], answers = [] } = {}) {
    const ui = { warnings: [], infos: [], errors: [], disposed: 0 };
    let listener;
    const panel = {
        webview: { html: '', cspSource: 'x', asWebviewUri: uri => uri.path, onDidReceiveMessage: fn => { listener = fn; return subscription(); } },
        onDidDispose: subscription, reveal() {}, dispose() { ui.disposed++; }
    };
    const vscode = {
        EventEmitter: RecordingEventEmitter, ViewColumn: { One: 1 },
        Uri: { joinPath: (base, ...segments) => ({ path: [base.path, ...segments].join('/') }) },
        workspace: { getConfiguration: () => ({ get: () => false }) },
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }), createWebviewPanel: () => panel,
            showWarningMessage: (...args) => Promise.resolve(answers[ui.warnings.push(args) - 1]),
            showInformationMessage: (...args) => { ui.infos.push(args); return Promise.resolve(undefined); },
            showErrorMessage: (...args) => { ui.errors.push(args); return Promise.resolve(undefined); }
        }
    };
    const globals = { process, setTimeout, clearTimeout, setInterval, clearInterval };
    const StubWebSocket = Object.assign(function () { throw new Error('no real socket'); }, { OPEN: 1 });
    const loadedClient = loadModule(CLIENT_SOURCE, 'MoeDaemonClient.ts', {
        vscode, ws: StubWebSocket, fs, path, net: require('node:net'), child_process: { spawn() { throw new Error('unexpected spawn'); } }
    }, globals);
    const client = new loadedClient.MoeDaemonClient('extension');
    const sent = [];
    client['ws'] = { readyState: 1, send: frame => sent.push(frame), close() {} };
    client['_connectionState'] = 'connected';
    const deliver = frame => client['handleMessage'](JSON.stringify(frame));
    deliver({ type: 'STATE_SNAPSHOT', payload: { project: { id: 'p', name: 'p', settings: {} }, epics: [epic], workers: [], proposals: [], tasks } });
    const loadedPanel = loadModule(PANEL_SOURCE, 'EpicDetailPanel.ts', { vscode }, globals);
    const instance = loadedPanel.EpicDetailPanel.createOrShow({ path: '/ext' }, client, epic.id, client.currentState);
    assert.equal(typeof listener, 'function', 'the panel registered no message listener');
    return {
        ui, sent, client, deliver, instance,
        save: (over = {}) => listener({ type: 'save', epicId: 'epic-1', title: '  Typed title ', description: 'new desc', architectureNotes: 'new notes', epicRails: ['rail one'], status: 'ARCHIVED', ...over }),
        echo: (status = 'ACTIVE') => deliver({ type: 'EPIC_UPDATED', payload: { ...EPIC, title: 'Typed title', status } })
    };
}

async function withPanel(options, run) {
    const h = open(options);
    try { await run(h); } finally { try { h.instance.dispose(); } finally { h.client.dispose(); } }
}

const none = h => assert.deepEqual([h.sent, h.ui.infos, h.ui.errors, h.ui.disposed], [[], [], [], 0]);

test('EA1 refusal: a stale cache lets the archive reach the daemon, whose message is shown and the edits stay', async () => {
    await withPanel({ tasks: [task('b1', 'BACKLOG'), task('d1', 'DONE')], answers: [ARCHIVE_TITLE] }, async h => {
        await h.save();
        assert.deepEqual([h.sent, h.ui.infos, h.ui.errors], [[FIELDS_FRAME], [], []], 'fields only, and no toast before the reply');
        h.echo();
        assert.deepEqual(h.sent, [FIELDS_FRAME, STATUS_FRAME]);
        h.deliver(REFUSAL);
        assert.deepEqual([h.ui.errors, h.ui.infos, h.ui.disposed], [[[`Epic "Typed title" was saved but not archived: ${REFUSAL.message}`]], [], 0]);
        await h.save();
        assert.equal(h.ui.warnings.length, 2, 'the panel is still usable: a second Save asks again');
    });
});

test('EA2 in-flight: an archive with a PLANNING, AWAITING_APPROVAL or WORKING task sends nothing and names the tasks', async () => {
    const rows = [task('p1', 'PLANNING'), task('a1', 'AWAITING_APPROVAL'), task('w1', 'WORKING'), task('b1', 'BACKLOG'), task('x1', 'WORKING', 'epic-2')];
    await withPanel({ tasks: rows }, async h => {
        await h.save();
        assert.equal(h.ui.warnings.length, 1);
        assert.equal(h.ui.warnings[0].length, 2, 'a plain modal: no button');
        assert.equal(h.ui.warnings[0][0], fill(IN_FLIGHT, EPIC.title, '- T-p1\n- T-a1\n- T-w1'));
        assert.equal(JSON.stringify(h.ui.warnings[0][1]), '{"modal":true}');
        none(h);
    });
    // Each in-flight status alone blocks, and the decision follows the newest cache (a later TASK_UPDATED), not the opened one.
    const cases = [['PLANNING', null, 2], ['AWAITING_APPROVAL', null, 2], ['WORKING', null, 2], ['BACKLOG', 'WORKING', 2], ['WORKING', 'BACKLOG', 3]];
    for (const [from, to, modalArgs] of cases) {
        await withPanel({ tasks: [task('t1', from)], answers: [ARCHIVE_TITLE] }, async h => {
            if (to) { h.deliver({ type: 'TASK_UPDATED', payload: task('t1', to) }); }
            await h.save();
            assert.deepEqual([h.ui.warnings.map(w => w.length), h.sent], [[modalArgs], modalArgs === 2 ? [] : [FIELDS_FRAME]], `${from} > ${to}`);
        });
    }
});

test('EA3 confirm: the archive asks first, counting this epic\'s tasks that are not archived', async () => {
    const rows = [task('b1', 'BACKLOG'), task('r1', 'REVIEW'), task('k1', 'BLOCKED'), task('d1', 'DONE'), task('z1', 'ARCHIVED'), task('x1', 'WORKING', 'epic-2')];
    await withPanel({ tasks: rows, answers: [ARCHIVE_TITLE] }, async h => {
        await h.save();
        assert.equal(h.ui.warnings.length, 1);
        const [text, options, button, ...rest] = h.ui.warnings[0];
        assert.equal(text, fill(CONFIRM, EPIC.title, '4'), 'the title holds {1} and $& and is inserted verbatim');
        assert.deepEqual([JSON.stringify(options), button, rest.length, h.sent], ['{"modal":true}', ARCHIVE_TITLE, 0, [FIELDS_FRAME]]);
    });
    await withPanel({ answers: [ARCHIVE_TITLE] }, async h => {
        await h.save();
        assert.equal(h.ui.warnings.length, 1, 'an epic with no tasks still asks');
        assert.equal(h.ui.warnings[0][0], fill(CONFIRM, EPIC.title, '0'));
    });
    for (const answer of [undefined, 'Cancel']) {
        await withPanel({ tasks: [task('b1', 'BACKLOG')], answers: [answer] }, async h => {
            await h.save();
            assert.equal(h.ui.warnings.length, 1);
            none(h);
        });
    }
});

test('EA4 archive: the status frame follows the fields echo, and only an ARCHIVED echo closes the panel', async () => {
    await withPanel({ tasks: [task('b1', 'BACKLOG')], answers: [ARCHIVE_TITLE] }, async h => {
        await h.save();
        h.echo();
        assert.deepEqual(h.sent, [FIELDS_FRAME, STATUS_FRAME]);
        h.echo();
        h.deliver({ type: 'TASK_UPDATED', payload: task('b1', 'ARCHIVED') });
        assert.deepEqual([h.sent.length, h.ui.infos, h.ui.disposed], [2, [], 0], 'a non-ARCHIVED echo and a cascade row change nothing');
        h.echo('ARCHIVED');
        assert.deepEqual([h.ui.infos, h.ui.disposed], [[['Epic "Typed title" archived.']], 1]);
        h.echo('ARCHIVED');
        h.deliver(REFUSAL);
        assert.deepEqual([h.sent.length, h.ui.infos.length, h.ui.errors, h.ui.disposed], [2, 1, [], 1], 'later frames change nothing');
    });
});

test('EA5 fields-refused: a refused field frame never sends the archive', async () => {
    await withPanel({ tasks: [task('b1', 'BACKLOG')], answers: [ARCHIVE_TITLE] }, async h => {
        await h.save();
        h.deliver({ ...REFUSAL, message: '[INVALID_INPUT] epicRails is too long' });
        assert.deepEqual(h.ui.errors, notSaved('[INVALID_INPUT] epicRails is too long'));
        h.echo();
        assert.deepEqual([h.sent, h.ui.infos, h.ui.disposed], [[FIELDS_FRAME], [], 0]);
    });
});

test('EA6 plain: a save that is not an archive move stays one frame, with its toast after the echo', async () => {
    const cases = [['PLANNED', EPIC], ['ACTIVE', EPIC], ['COMPLETED', EPIC], ['ARCHIVED', { ...EPIC, status: 'ARCHIVED' }], ['ARCHIVED', { ...EPIC, id: 'epic-9' }]];
    for (const [status, epic] of cases) {
        await withPanel({ epic, tasks: [task('w1', 'WORKING')] }, async h => {
            await h.save({ status });
            assert.deepEqual([h.sent, h.ui.warnings, h.ui.infos, h.ui.errors, h.ui.disposed], [[oneFrame(status)], [], [], [], 0], `${status} ${epic.id}`);
            h.echo(status);
            assert.deepEqual([h.ui.infos, h.ui.disposed], [[['Epic "Typed title" updated.']], 1], `${status} ${epic.id}`);
        });
    }
    await withPanel({ tasks: [task('w1', 'WORKING')] }, async h => {
        await h.save({ status: 'ACTIVE' });
        h.deliver(REFUSAL);
        assert.deepEqual([h.ui.errors, h.ui.infos, h.ui.disposed], [notSaved(REFUSAL.message), [], 0]);
    });
});

test('EA7 one-save: one save is in flight, and unrelated errors and echoes are ignored', async () => {
    await withPanel({ tasks: [task('b1', 'BACKLOG')], answers: [ARCHIVE_TITLE] }, async h => {
        await h.save();
        await h.save();
        assert.deepEqual([h.sent, h.ui.infos, h.ui.warnings.length], [[FIELDS_FRAME], [WAITING], 1], 'no second frame and no second modal');
        for (const frame of [{ ...REFUSAL, context: { epicId: 'epic-2' } }, { ...REFUSAL, operation: 'UPDATE_TASK' }, { type: 'ERROR', message: 'boom' }]) { h.deliver(frame); }
        h.deliver({ type: 'EPIC_UPDATED', payload: { ...EPIC, id: 'epic-2' } });
        // The panel ignores them all; the two that are not epic saves get the client's generic notice (JetBrains parity).
        const notices = [[`Moe: UPDATE_TASK failed: ${REFUSAL.message}`], ['Moe: boom']];
        assert.deepEqual([h.sent, h.ui.errors, h.ui.infos, h.ui.disposed], [[FIELDS_FRAME], notices, [WAITING], 0]);
    });
    let release;
    await withPanel({ tasks: [task('b1', 'BACKLOG')], answers: [new Promise(resolve => { release = resolve; })] }, async h => {
        const first = h.save();
        await h.save();
        assert.deepEqual([h.ui.infos, h.ui.warnings.length], [[WAITING], 1], 'a Save while the confirm modal is open waits too');
        release(ARCHIVE_TITLE);
        await first;
        assert.deepEqual(h.sent, [FIELDS_FRAME]);
    });
});

test('EA8 connection: a failed send or a lost connection gives one message and keeps the panel', async () => {
    await withPanel({}, async h => {
        h.client['_connectionState'] = 'disconnected';
        await h.save({ status: 'ACTIVE' });
        assert.deepEqual(h.ui.warnings, [['Not connected to Moe daemon — epic was not saved.']]);
        none(h);
    });
    await withPanel({}, async h => {
        await h.save({ status: 'ACTIVE' });
        h.client.disconnect();
        h.echo('ACTIVE');
        assert.deepEqual(h.ui.warnings, [[LOST]]);
        assert.deepEqual([h.sent.length, h.ui.infos, h.ui.disposed], [1, [], 0], 'a later echo neither sends nor closes');
    });
    for (const failure of ['state', 'throw']) {
        await withPanel({ tasks: [task('b1', 'BACKLOG')], answers: [ARCHIVE_TITLE] }, async h => {
            await h.save();
            if (failure === 'state') { h.client['_connectionState'] = 'disconnected'; } else { h.client['ws'].send = () => { throw new Error('socket is gone'); }; }
            h.echo();
            const expected = failure === 'state' ? 'Not connected to Moe daemon — epic was saved but not archived.' : LOST;
            assert.deepEqual(h.ui.warnings.slice(1), [[expected]], failure);
            h.echo('ARCHIVED');
            assert.deepEqual([h.sent, h.ui.infos, h.ui.errors, h.ui.disposed], [[FIELDS_FRAME], [], [], 0], failure);
        });
    }
});

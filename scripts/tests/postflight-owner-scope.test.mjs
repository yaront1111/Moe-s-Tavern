// Standalone tests for the get_commit_scope ownership knobs of the shared
// postflight-fake-proxy.js (FAKE_SCOPE_ASSIGNEE, FAKE_SCOPE_ASSIGNEE_ALIVE,
// FAKE_SCOPE_ASSIGNEE_PROTECTED, FAKE_SCOPE_OWNERSHIP_MODE). No daemon, no
// network: each case runs the fake once against a throwaway project, with every
// inherited FAKE_*/MOE_* export removed so a seat's own environment cannot steer it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fakePath = fileURLToPath(new URL('./postflight-fake-proxy.js', import.meta.url));
const TASK_ID = 'task-postflight';

function makeProject(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-owner-scope-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    fs.mkdirSync(path.join(dir, '.moe', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moe', 'project.json'), JSON.stringify({ id: 'proj-test', name: 'owner-scope', settings: {} }));
    fs.writeFileSync(path.join(dir, '.moe', 'tasks', `${TASK_ID}.json`), JSON.stringify({
        id: TASK_ID,
        title: 'Owner scope',
        status: 'WORKING',
        implementationPlan: [{ stepId: 'step-1', description: 'edit', status: 'COMPLETED', modifiedFiles: ['src/a.ts'] }],
    }));
    return dir;
}

function runFake(dir, tool, args, knobs = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(FAKE_|MOE_)/i.test(key)) delete env[key];
    }
    Object.assign(env, { MOE_PROJECT_PATH: dir }, knobs);
    const input = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `moe.${tool}`, arguments: args } })}\n`;
    return spawnSync(process.execPath, [fakePath], { input, cwd: dir, env, encoding: 'utf8', timeout: 10_000 });
}

function parseReply(child) {
    assert.equal(child.status, 0, child.stderr);
    const lines = child.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    return JSON.parse(JSON.parse(lines[0]).result.content[0].text);
}

// workerId null models a call without one (the proxy did not inject it).
function scope(dir, knobs = {}, workerId = 'architect-x') {
    const args = { taskId: TASK_ID, phase: 'postflight', ...(workerId === null ? {} : { workerId }) };
    return parseReply(runFake(dir, 'get_commit_scope', args, knobs));
}

// The reply before the ownership knobs existed, for a caller that is the assignee.
const LEGACY = {
    taskId: TASK_ID,
    title: 'Owner scope',
    status: 'WORKING',
    epicId: 'epic-1',
    reopenCount: 0,
    assignedWorkerId: 'architect-x',
    assigneeAlive: true,
    asserted: ['src/a.ts'],
    planned: [],
    touchedFiles: [],
    inferredPaths: [],
    unattributedPaths: [],
    peerDeclared: [],
    livePeerIds: [],
    activePeerIds: [],
    peersActive: false,
    alwaysInclude: [`.moe/tasks/${TASK_ID}.json`, '.moe/project.json'],
    excludePrefixes: [],
    policy: { autoCommit: true, checkpointCommits: true, checkpointPush: true, commitBoardState: true, commitHooks: false, undeclared: 'solo', contested: 'commit' },
};
const FOREIGN_KNOBS = { FAKE_SCOPE_ASSIGNEE: 'worker-owner' };
const FOREIGN = { ...LEGACY, assignedWorkerId: 'worker-owner', assigneeProtected: true, activePeerIds: ['architect-x'], peersActive: true };

test('an unchanged invocation answers as before, plus assigneeProtected true', (t) => {
    const reply = scope(makeProject(t));
    assert.deepStrictEqual(reply, { ...LEGACY, assigneeProtected: true });
    assert.deepStrictEqual(Object.keys(reply).sort(), [...Object.keys(LEGACY), 'assigneeProtected'].sort());
});

test('FAKE_SCOPE_PEERS_ACTIVE leaves the legacy peer fields as they were', (t) => {
    const reply = scope(makeProject(t), { FAKE_SCOPE_PEERS_ACTIVE: '1' });
    assert.deepStrictEqual(reply, {
        ...LEGACY, assigneeProtected: true, livePeerIds: ['worker-peer'], activePeerIds: ['worker-peer'], peersActive: true,
    });
});

test('without a workerId nobody is assigned: assigneeAlive stays true, assigneeProtected is false', (t) => {
    const reply = scope(makeProject(t), {}, null);
    assert.deepStrictEqual(reply, { ...LEGACY, assignedWorkerId: null, assigneeProtected: false });
});

test('an empty FAKE_SCOPE_ASSIGNEE answers exactly like an unset one', (t) => {
    const dir = makeProject(t);
    assert.deepStrictEqual(scope(dir, { FAKE_SCOPE_ASSIGNEE: '' }), scope(dir));
    assert.deepStrictEqual(scope(dir, { FAKE_SCOPE_ASSIGNEE: '' }, null), scope(dir, {}, null));
});

test('a foreign assignee is protected and the caller joins activePeerIds, as in the daemon', (t) => {
    const reply = scope(makeProject(t), FOREIGN_KNOBS);
    assert.deepStrictEqual(reply, FOREIGN);
    assert.deepStrictEqual(reply.livePeerIds, LEGACY.livePeerIds);
    assert.deepStrictEqual(reply.alwaysInclude, LEGACY.alwaysInclude);
});

test('a quiet owner is not alive but stays protected', (t) => {
    const reply = scope(makeProject(t), { ...FOREIGN_KNOBS, FAKE_SCOPE_ASSIGNEE_ALIVE: '0' });
    assert.deepStrictEqual(reply, { ...FOREIGN, assigneeAlive: false });
});

test('a dead or missing owner is neither alive nor protected', (t) => {
    const reply = scope(makeProject(t), { ...FOREIGN_KNOBS, FAKE_SCOPE_ASSIGNEE_ALIVE: '0', FAKE_SCOPE_ASSIGNEE_PROTECTED: '0' });
    assert.deepStrictEqual(reply, { ...FOREIGN, assigneeAlive: false, assigneeProtected: false });
});

test('the none sentinel is an unassigned task, with the caller counted as active', (t) => {
    const reply = scope(makeProject(t), { FAKE_SCOPE_ASSIGNEE: 'none' });
    assert.deepStrictEqual(reply, {
        ...LEGACY, assignedWorkerId: null, assigneeAlive: false, assigneeProtected: false, activePeerIds: ['architect-x'], peersActive: true,
    });
});

test('PROTECTED and ALIVE can be set explicitly on the caller-as-assignee default too', (t) => {
    const dir = makeProject(t);
    assert.deepStrictEqual(scope(dir, { FAKE_SCOPE_ASSIGNEE_PROTECTED: '0' }), { ...LEGACY, assigneeProtected: false });
    assert.deepStrictEqual(scope(dir, { FAKE_SCOPE_ASSIGNEE_ALIVE: '0' }), { ...LEGACY, assigneeAlive: false, assigneeProtected: true });
    assert.deepStrictEqual(scope(dir, { FAKE_SCOPE_ASSIGNEE: 'none', FAKE_SCOPE_ASSIGNEE_PROTECTED: '1', FAKE_SCOPE_ASSIGNEE_ALIVE: '1' }), {
        ...LEGACY, assignedWorkerId: null, assigneeProtected: true, activePeerIds: ['architect-x'], peersActive: true,
    });
});

test('omit drops only the assigneeProtected key, as a daemon from before the field does', (t) => {
    const dir = makeProject(t);
    const reply = scope(dir, { ...FOREIGN_KNOBS, FAKE_SCOPE_OWNERSHIP_MODE: 'omit' });
    const { assigneeProtected, ...withoutField } = FOREIGN;
    assert.equal(assigneeProtected, true);
    assert.deepStrictEqual(reply, withoutField);
    assert.equal('assigneeProtected' in reply, false);
    // Even for a protected-false reply, and on the default invocation: legacy output is untouched.
    assert.equal('assigneeProtected' in scope(dir, { FAKE_SCOPE_ASSIGNEE_PROTECTED: '0', FAKE_SCOPE_OWNERSHIP_MODE: 'omit' }), false);
    assert.deepStrictEqual(scope(dir, { FAKE_SCOPE_OWNERSHIP_MODE: 'omit' }), LEGACY);
});

test('malformed serves the value as a string, the coercion trap a wrapper must refuse', (t) => {
    const dir = makeProject(t);
    const off = scope(dir, { FAKE_SCOPE_ASSIGNEE_PROTECTED: '0', FAKE_SCOPE_OWNERSHIP_MODE: 'malformed' });
    assert.equal(typeof off.assigneeProtected, 'string');
    assert.equal(off.assigneeProtected, 'false');
    assert.deepStrictEqual(off, { ...LEGACY, assigneeProtected: 'false' });
    const on = scope(dir, { FAKE_SCOPE_OWNERSHIP_MODE: 'malformed' });
    assert.equal(on.assigneeProtected, 'true');
    assert.deepStrictEqual(on, { ...LEGACY, assigneeProtected: 'true' });
});

test('a mistyped knob fails loudly, naming the knob, with nothing on stdout', (t) => {
    const dir = makeProject(t);
    for (const [knob, value] of [
        ['FAKE_SCOPE_ASSIGNEE_PROTECTED', 'yes'],
        ['FAKE_SCOPE_ASSIGNEE_ALIVE', '2'],
        ['FAKE_SCOPE_OWNERSHIP_MODE', 'bogus'],
    ]) {
        const child = runFake(dir, 'get_commit_scope', { taskId: TASK_ID, phase: 'postflight', workerId: 'architect-x' }, { [knob]: value });
        assert.notEqual(child.status, 0, knob);
        assert.equal(child.stdout, '', knob);
        assert.match(child.stderr, new RegExp(`Error: ${knob} must be .*"${value}"`), knob);
        // The knobs belong to get_commit_scope alone: any other call answers normally.
        assert.deepStrictEqual(parseReply(runFake(dir, 'heartbeat', { workerId: 'architect-x' }, { [knob]: value })), { ok: true }, knob);
    }
});

test('seat exports of FAKE_* and MOE_* in the parent process do not steer the fixture', (t) => {
    const dir = makeProject(t);
    const saved = { ...process.env };
    Object.assign(process.env, { FAKE_SCOPE_ASSIGNEE: 'worker-leak', FAKE_SCOPE_ASSIGNEE_PROTECTED: 'yes', MOE_WORKER_ID: 'worker-leak' });
    try {
        assert.deepStrictEqual(scope(dir), { ...LEGACY, assigneeProtected: true });
    } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
    }
});

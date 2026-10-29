import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter } from './McpAdapter.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { activeChatWaiters } from '../tools/chatWait.js';
import * as speedMode from '../tools/submitPlan.js';
import { decodeClientHello } from './clientCapabilities.js';
import type { TaskExecutionContract } from '../types/schema.js';

describe('MoeWebSocketServer Integration', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  let mcpAdapter: McpAdapter;
  let httpServer: Server;
  let wsServer: MoeWebSocketServer;
  let port: number;

  function setupMoeFolder() {
    fs.mkdirSync(moePath, { recursive: true });
    fs.mkdirSync(path.join(moePath, 'epics'));
    fs.mkdirSync(path.join(moePath, 'tasks'));
    fs.mkdirSync(path.join(moePath, 'workers'));
    fs.mkdirSync(path.join(moePath, 'proposals'));

    const project = {
      id: 'proj-test',
      name: 'Test Project',
      rootPath: testDir,
      globalRails: {
        techStack: [],
        forbiddenPatterns: [],
        requiredPatterns: [],
        formatting: '',
        testing: '',
        customRules: [],
      },
      settings: {
        approvalMode: 'CONTROL',
        speedModeDelayMs: 2000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  function createEpic(id = 'epic-1') {
    const epic = {
      id,
      projectId: 'proj-test',
      title: 'Test Epic',
      description: 'Test description',
      architectureNotes: '',
      epicRails: [],
      status: 'ACTIVE',
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', `${id}.json`), JSON.stringify(epic, null, 2));
  }

  function createTask(id = 'task-1') {
    const task = {
      id,
      epicId: 'epic-1',
      title: 'Test Task',
      description: 'Test description',
      definitionOfDone: [],
      taskRails: [],
      implementationPlan: [],
      status: 'BACKLOG',
      assignedWorkerId: null,
      branch: null,
      prLink: null,
      reopenCount: 0,
      reopenReason: null,
      createdBy: 'HUMAN',
      parentTaskId: null,
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify(task, null, 2));
  }

  beforeEach(async () => {
    // Create temp directory (cross-platform)
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ws-test-'));
    moePath = path.join(testDir, '.moe');
    setupMoeFolder();
    createEpic();
    createTask();

    state = new StateManager({ projectPath: testDir });
    await state.load();
    mcpAdapter = new McpAdapter(state);

    // Create HTTP server on random available port
    httpServer = createServer();
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address();
        if (address && typeof address === 'object') {
          port = address.port;
        }
        resolve();
      });
    });

    wsServer = new MoeWebSocketServer(httpServer, state, mcpAdapter);
  });

  afterEach(async () => {
    // Close all WebSocket connections first, then the HTTP server
    if (wsServer && !wsServer.closed) {
      await wsServer.close();
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    for (const waiter of activeWaiters.values()) clearTimeout(waiter.timer);
    activeWaiters.clear();
    for (const waiter of activeChatWaiters.values()) clearTimeout(waiter.timer);
    activeChatWaiters.clear();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Plugin endpoint (/ws)', () => {
    // Helper: connect and collect messages in order to avoid race conditions.
    // The STATE_SNAPSHOT can arrive before a late-registered handler, so we
    // buffer messages from the start.
    function connectAndCollect(endpoint = '/ws') {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
      const messages: string[] = [];
      let waiting: ((msg: string) => void) | null = null;

      ws.on('message', (data) => {
        const msg = data.toString();
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(msg);
        } else {
          messages.push(msg);
        }
      });

      const ready = new Promise<void>((resolve) => ws.on('open', () => resolve()));

      function nextMessage(timeoutMs = 5000): Promise<string> {
        if (messages.length > 0) {
          return Promise.resolve(messages.shift()!);
        }
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => { waiting = null; reject(new Error('Timeout')); }, timeoutMs);
          waiting = message => { clearTimeout(timer); resolve(message); };
        });
      }

      return { ws, ready, nextMessage };
    }

    describe('capability negotiation v1', () => {
      afterEach(() => { vi.restoreAllMocks(); state.clearEmitter(); });
      const serverCapabilities = {
        executionProfiles: true, planRevisions: true, approvalRevisions: true,
        executionContracts: true, deliveryReceipts: true, requiredChecks: true,
        runnerStatus: false, modelReceipts: false, verifiedLocal: false,
      };
      const allClaimed = Object.fromEntries(Object.keys(serverCapabilities).map(key => [key, true]));
      const hello = (capabilities: Record<string, unknown> = allClaimed) => ({
        type: 'CLIENT_HELLO', payload: { protocolVersion: 1, capabilities },
      });
      const approval = (type: string, expectedPlanRevision?: unknown) => ({
        type, payload: { taskId: 'task-1', expectedPlanRevision,
          ...(type === 'UPDATE_TASK' ? { updates: { status: 'WORKING' } } : {}) },
      });
      type Client = ReturnType<typeof connectAndCollect>;
      type Frame = { type: string; payload: Record<string, unknown>; code?: number; codeName?: string };
      const next = async (client: Client): Promise<Frame> => JSON.parse(await client.nextMessage());
      async function request(client: Client, frame: unknown): Promise<Frame> {
        client.ws.send(JSON.stringify(frame));
        return next(client);
      }
      async function connect(): Promise<Client> {
        const client = connectAndCollect();
        await client.ready;
        expect((await next(client)).type).toBe('STATE_SNAPSHOT');
        return client;
      }
      async function seed(row: Record<string, unknown> = {}, profile = 'legacy'): Promise<string> {
        const file = path.join(moePath, 'tasks', 'task-1.json');
        fs.writeFileSync(file, JSON.stringify({ ...state.getTask('task-1'),
          status: 'AWAITING_APPROVAL', planRevision: 4, ...row }));
        const projectFile = path.join(moePath, 'project.json');
        const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
        project.settings.executionProfile = profile;
        fs.writeFileSync(projectFile, JSON.stringify(project));
        await state.load();
        return file;
      }
      async function refused(client: Client, frame: unknown, codeName: string): Promise<void> {
        await state.flushActivityLog();
        const file = path.join(moePath, 'tasks', 'task-1.json');
        const bytes = fs.readFileSync(file, 'utf8');
        const before = structuredClone(state.getTask('task-1'));
        const activity = state.getActivityLog(500);
        const cancel = vi.spyOn(speedMode, 'cancelSpeedModeTimeout');
        const events: string[] = [];
        const unsubscribe = state.subscribe(event => events.push(event.type));
        expect(await request(client, frame)).toMatchObject({ type: 'ERROR', codeName });
        unsubscribe();
        await state.flushActivityLog();
        expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
        expect(state.getTask('task-1')).toEqual(before);
        expect(state.getActivityLog(500)).toEqual(activity);
        expect(events).toEqual([]);
        expect(cancel).not.toHaveBeenCalled();
        cancel.mockRestore();
        // PONG is a barrier: no hidden TASK_UPDATED was sent on refusal.
        expect(await request(client, { type: 'PING' })).toEqual({ type: 'PONG' });
      }

      it('replies only on demand with exact maps, ignoring unknown optional keys', async () => {
        const client = await connect();
        const peer = await connect();
        expect((await request(client, { type: 'GET_STATE' })).type).toBe('STATE_SNAPSHOT');
        const frame = hello({ ...allClaimed, future: { nested: true } });
        const reply = await request(client, { ...frame, future: 1, payload: { ...frame.payload, extra: [] } });
        expect(reply).toEqual({ type: 'SERVER_CAPABILITIES', payload: {
          protocolVersion: 1, capabilities: serverCapabilities, negotiatedCapabilities: serverCapabilities,
        } });
        expect(await request(peer, { type: 'PING' })).toEqual({ type: 'PONG' });
      });

      it.each([{}, { planRevisions: true }, { planRevisions: false }])('intersects client claims %j', async claims => {
        const client = await connect();
        const negotiated = Object.fromEntries(Object.entries(serverCapabilities).map(([key, value]) =>
          [key, value && (claims as Record<string, unknown>)[key] === true]));
        expect(await request(client, hello(claims))).toEqual({ type: 'SERVER_CAPABILITIES', payload: {
          protocolVersion: 1, capabilities: serverCapabilities, negotiatedCapabilities: negotiated,
        } });
      });

      const invalidPayloads = [undefined, null, [], true, 'hello', {},
        ...[undefined, null, [], true, 'caps'].map(capabilities => ({ protocolVersion: 1, capabilities })),
        ...[undefined, null, '1', true, -0.5, Number.MAX_SAFE_INTEGER + 1].map(protocolVersion =>
          ({ protocolVersion, capabilities: {} })),
        ...Object.keys(serverCapabilities).map(key => ({ protocolVersion: 1, capabilities: { [key]: 1 } })),
        ...[null, 'true', [], {}].map(planRevisions => ({ protocolVersion: 1, capabilities: { planRevisions } })),
      ];
      it('decodes the pure v1 contract without retaining caller fields', () => {
        for (const payload of invalidPayloads) {
          expect(() => decodeClientHello(payload)).toThrow(expect.objectContaining({ codeName: 'INVALID_INPUT' }));
        }
        expect(() => decodeClientHello({ protocolVersion: 2, capabilities: {} }))
          .toThrow(expect.objectContaining({ codeName: 'UNSUPPORTED_CLIENT_PROTOCOL' }));
        const payload = hello({ ...allClaimed, future: 'ignored' }).payload;
        const before = structuredClone(payload);
        expect(decodeClientHello(payload)).toEqual({ protocolVersion: 1,
          capabilities: serverCapabilities, negotiatedCapabilities: serverCapabilities });
        expect(payload).toEqual(before);
      });
      it.each(invalidPayloads)('rejects malformed hello %j without legacy fallback', async payload => {
        await seed();
        const client = await connect();
        await refused(client, { type: 'CLIENT_HELLO', payload }, 'INVALID_INPUT');
        for (const route of ['APPROVE_TASK', 'UPDATE_TASK']) {
          await refused(client, approval(route, 4), 'UNSUPPORTED_CLIENT_CAPABILITY');
        }
        expect((await request(client, hello())).type).toBe('SERVER_CAPABILITIES');
        expect((await request(client, approval('APPROVE_TASK', 4))).type).toBe('TASK_UPDATED');
      });

      it.each([0, -1, 2, Number.MAX_SAFE_INTEGER])('rejects unsupported integer version %s', async protocolVersion => {
        const client = await connect();
        expect(await request(client, { type: 'CLIENT_HELLO', payload: { protocolVersion, capabilities: {} } }))
          .toMatchObject({ type: 'ERROR', code: -32003, codeName: 'UNSUPPORTED_CLIENT_PROTOCOL' });
      });

      it('locks a successful intersection across repeats and malformed retries', async () => {
        await seed();
        const client = await connect();
        const first = await request(client, hello());
        // Raw order, optional keys and unsupported claims do not change the intersection.
        expect(await request(client, hello(Object.fromEntries(Object.entries({ ...serverCapabilities, future: null }).reverse())))).toEqual(first);
        await refused(client, hello({}), 'CLIENT_CAPABILITIES_LOCKED');
        await refused(client, { type: 'CLIENT_HELLO', payload: null }, 'INVALID_INPUT');
        await refused(client, approval('APPROVE_TASK'), 'INVALID_INPUT');
        expect((await request(client, approval('APPROVE_TASK', 4))).type).toBe('TASK_UPDATED');
      });

      it('keeps incapable sockets isolated, locked, and reset only by reconnect', async () => {
        await seed();
        const client = await connect();
        const peer = await connect();
        await request(client, hello({}));
        await request(peer, hello());
        await refused(client, hello(), 'CLIENT_CAPABILITIES_LOCKED');
        await refused(client, approval('APPROVE_TASK', 4), 'UNSUPPORTED_CLIENT_CAPABILITY');
        await refused(peer, approval('APPROVE_TASK'), 'INVALID_INPUT');
        client.ws.close();
        const reconnected = await connect();
        // CQ-F MODIFY_RAIL prop-5e7763ed (human-approved 2026-10-25): revision-less human plan approval is deleted.
        expect((await request(reconnected, approval('APPROVE_TASK', 4))).type).toBe('TASK_UPDATED');
      });

      for (const route of ['APPROVE_TASK', 'UPDATE_TASK']) {
        // CQ-F MODIFY_RAIL prop-5e7763ed (human-approved 2026-10-25): revision-less human plan approval is deleted.
        it.each(['legacy', 'observe'])(`${route} refuses unnegotiated %s omission without side effects`, async profile => {
          await seed({}, profile);
          const client = await connect();
          await refused(client, approval(route), 'INVALID_INPUT');
          expect(state.getTask('task-1')).toMatchObject({ status: 'AWAITING_APPROVAL' });
          expect(state.getTask('task-1')).not.toHaveProperty('approvedPlanRevision');
        });
        it.each([undefined, null, '4', true, -1, 4.5, Number.MAX_SAFE_INTEGER + 1, 3, 5])(
          `${route} refuses negotiated token %j without side effects`, async token => {
            await seed();
            const client = await connect();
            await request(client, hello());
            await refused(client, approval(route, token), token === 3 || token === 5 ? 'PLAN_REVISION_MISMATCH' : 'INVALID_INPUT');
          });
        it.each([{}, { planRevisions: false }])(`${route} requires revision capability %j even with a token`, async claims => {
          await seed();
          const client = await connect();
          await request(client, hello(claims));
          await refused(client, approval(route, 4), 'UNSUPPORTED_CLIENT_CAPABILITY');
        });
        it(`${route} persists only the reviewed revision`, async () => {
          const file = await seed();
          const client = await connect();
          await request(client, hello());
          expect(await request(client, approval(route, 4))).toMatchObject({ type: 'TASK_UPDATED',
            payload: { status: 'WORKING', planRevision: 4, approvedPlanRevision: 4 } });
          expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ approvedPlanRevision: 4 });
        });
        it(`${route} rechecks a token queued behind a material edit under the mutex`, async () => {
          const file = await seed();
          const client = await connect();
          expect((await request(client, hello())).type).toBe('SERVER_CAPABILITIES');
          const exclusive = vi.spyOn(state, 'runExclusive');
          let release!: () => void;
          const hold = new Promise<void>(resolve => { release = resolve; });
          let bytes: string, activity: unknown;
          const published: string[] = [];
          const cancel = vi.spyOn(speedMode, 'cancelSpeedModeTimeout');
          const unsubscribe = state.subscribe(event => published.push(event.type));
          const edit = state.runExclusive(async () => {
            await hold;
            await state.updateTask('task-1', { executionContract: { intendedBehavior: 'New contract' } });
            await state.flushActivityLog();
            bytes = fs.readFileSync(file, 'utf8');
            activity = state.getActivityLog(500);
          });
          const reply = request(client, approval(route, 4));
          try { await vi.waitFor(() => expect(exclusive).toHaveBeenCalledTimes(2)); }
          finally { release(); }
          await edit;
          expect(await reply).toMatchObject({ type: 'ERROR', codeName: 'PLAN_REVISION_MISMATCH',
            context: { expectedPlanRevision: 4, currentPlanRevision: 5 } });
          await state.flushActivityLog();
          unsubscribe();
          expect(fs.readFileSync(file, 'utf8')).toBe(bytes!);
          expect(state.getActivityLog(500)).toEqual(activity);
          expect(published).toEqual(['TASK_UPDATED']);
          expect(cancel).not.toHaveBeenCalled();
          expect(await request(client, { type: 'PING' })).toEqual({ type: 'PONG' });
        });
        it(`${route} cannot activate verified-local by claiming every capability`, async () => {
          await seed({}, 'verified-local');
          const client = await connect();
          await request(client, hello());
          await refused(client, approval(route, 4), 'EXECUTION_PROFILE_NOT_READY');
        });
      }

      it('serializes a failed hello before an immediately following approval', async () => {
        await seed();
        const client = await connect();
        const exclusive = vi.spyOn(state, 'runExclusive');
        let release!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const busy = state.runExclusive(() => hold);
        client.ws.send(JSON.stringify({ type: 'CLIENT_HELLO', payload: null }));
        client.ws.send(JSON.stringify(approval('APPROVE_TASK')));
        try { await vi.waitFor(() => expect(exclusive).toHaveBeenCalledTimes(3)); }
        finally { release(); }
        await busy;
        expect(await next(client)).toMatchObject({ type: 'ERROR', codeName: 'INVALID_INPUT' });
        expect(await next(client)).toMatchObject({ type: 'ERROR', codeName: 'UNSUPPORTED_CLIENT_CAPABILITY' });
        expect(state.getTask('task-1')!.status).toBe('AWAITING_APPROVAL');
      });

      it('serializes competing negotiated approvals to one durable stamp', async () => {
        await seed();
        const clients = await Promise.all([connect(), connect()]);
        await Promise.all(clients.map(client => request(client, hello())));
        const write = vi.spyOn(state, 'writeEntity');
        const replies = await Promise.all(clients.map(client => request(client, approval('APPROVE_TASK', 4))));
        expect(replies.map(reply => reply.type).sort()).toEqual(['ERROR', 'TASK_UPDATED']);
        expect(write.mock.calls.filter(([kind]) => kind === 'tasks')).toHaveLength(1);
        expect(state.getTask('task-1')).toMatchObject({ planRevision: 4, approvedPlanRevision: 4 });
      });

      it('does not use a token hidden in updates or restrict ordinary edits', async () => {
        await seed();
        const client = await connect();
        await request(client, hello());
        await refused(client, { type: 'UPDATE_TASK', payload: { taskId: 'task-1',
          updates: { status: 'WORKING', expectedPlanRevision: 4 } } }, 'INVALID_INPUT');
        expect(await request(client, { type: 'UPDATE_TASK', payload: { taskId: 'task-1', updates: { title: 'Rename' } } }))
          .toMatchObject({ type: 'TASK_UPDATED', payload: { title: 'Rename' } });
      });

      it('roundtrips profile, revisions, contract, evidence and unknown task fields without reshaping snapshots', async () => {
        const contract: TaskExecutionContract = { intendedBehavior: 'Preserve exact JSON', requiredChecks: [{ id: 'gate', command: 'node gate.cjs' }] };
        const snapshot = { version: 2, profile: 'observe', planRevision: 4, deliveryPolicy: 'local-branch' };
        const row = { executionContract: contract, executionPolicySnapshot: snapshot,
          approvedPlanRevision: 3, futureField: { nested: ['unchanged'] } };
        await seed(row, 'observe');
        state.project!.settings = { ...state.project!.settings, deliveryPolicy: 'local-branch', autoCommit: true };
        const sha = 'ab'.repeat(20), base = 'cd'.repeat(20), timestamp = '2026-10-01T00:00:00Z';
        state.attempts.set('a', { id: 'a', taskId: 'task-1', workerId: 'w', runnerId: 'r', generation: 1,
          workspace: testDir, phase: 'finalizing', startedAt: timestamp, lastPhaseAt: timestamp });
        state.candidates.set('c', { id: 'c', taskId: 'task-1', attemptId: 'a', treeSha: sha,
          baseRevision: base, deliveryTarget: 'refs/heads/test', createdAt: timestamp });
        state.checkRuns.set('k', { id: 'k', candidateId: 'c', treeSha: sha, command: 'node gate.cjs',
          exitCode: 0, outputTail: '', runnerId: 'r', source: 'runner-observed', createdAt: timestamp });
        state.receipts.set('d', { id: 'd', candidateId: 'c', target: 'refs/heads/test', targetBefore: base,
          targetAfter: sha, landedRevision: sha, pushResult: null });
        const expected = { ...state.getTask('task-1'), ...row, delivery: {
          currentCandidate: { id: 'c', treeSha: sha, shortSha: sha.slice(0, 8), baseRevision: base },
          latestCheckRun: { command: 'node gate.cjs', exitCode: 0, source: 'runner-observed' },
          requiredCheckSatisfied: false, deliveryReceipt: { target: 'refs/heads/test', landedRevision: sha },
          attemptPhase: 'finalizing',
        } };
        const client = connectAndCollect();
        const initial = await next(client);
        expect(initial.payload.tasks).toEqual([expected]);
        expect(initial.payload.project).toMatchObject({ settings: { executionProfile: 'observe' } });
        await request(client, hello());
        expect(await request(client, { type: 'GET_STATE' })).toEqual(initial);
        const peer = await connect();
        state.setEmitter(event => wsServer.broadcast(event));
        client.ws.send(JSON.stringify({ type: 'UPDATE_TASK', payload: { taskId: 'task-1', updates: { title: 'Wire' } } }));
        const broadcast = await next(peer), ownBroadcast = await next(client), reply = await next(client);
        const updated = { ...expected, title: 'Wire', updatedAt: state.getTask('task-1')!.updatedAt };
        for (const frame of [broadcast, ownBroadcast, reply]) {
          expect(frame).toMatchObject({ type: 'TASK_UPDATED', payload: updated });
          expect(frame.payload).toEqual(updated);
        }
        expect(state.getTask('task-1')).not.toHaveProperty('delivery');
        state.clearEmitter();
      });
    });

    it('sends STATE_SNAPSHOT on connection', async () => {
      const { ws, nextMessage } = connectAndCollect();

      const message = await nextMessage();
      const parsed = JSON.parse(message);
      expect(parsed.type).toBe('STATE_SNAPSHOT');
      expect(parsed.payload.project.name).toBe('Test Project');
      expect(parsed.payload.tasks.length).toBe(1);

      ws.close();
    });

    it('responds to PING with PONG', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      // Send PING
      ws.send(JSON.stringify({ type: 'PING' }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('PONG');

      ws.close();
    });

    it('responds to GET_STATE', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      // Request state
      ws.send(JSON.stringify({ type: 'GET_STATE' }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('STATE_SNAPSHOT');
      expect(parsed.payload.epics.length).toBe(1);

      ws.close();
    });

    // Drain messages until a TASK_UPDATED reply arrives (broadcasts may interleave).
    async function nextTaskUpdated(nextMessage: (ms?: number) => Promise<string>) {
      for (let i = 0; i < 10; i++) {
        const parsed = JSON.parse(await nextMessage());
        if (parsed.type === 'TASK_UPDATED') return parsed;
        if (parsed.type === 'ERROR') throw new Error(`Unexpected ERROR: ${parsed.message}`);
      }
      throw new Error('No TASK_UPDATED received');
    }

    it('UPDATE_TASK DONE→WORKING scrubs completion signals, resets steps, and bumps reopenCount', async () => {
      // Seed a DONE task with a completed plan + completion timestamps via the daemon.
      await state.updateTask('task-1', {
        status: 'DONE',
        completedAt: new Date().toISOString(),
        reviewStartedAt: new Date().toISOString(),
        reviewCompletedAt: new Date().toISOString(),
        metrics: { doneAt: new Date().toISOString(), wallClockMs: 12345 },
        implementationPlan: [
          { stepId: 'step-1', description: 'Do thing', status: 'COMPLETED', affectedFiles: [], completedAt: new Date().toISOString() },
        ],
        stepsCompleted: ['step-1'],
      });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' } },
      }));

      const parsed = await nextTaskUpdated(nextMessage);
      const updated = parsed.payload;
      expect(updated.status).toBe('WORKING');
      expect(updated.reopenCount).toBe(1);
      // Completion signals scrubbed.
      expect(updated.completedAt == null).toBe(true);
      expect(updated.reviewStartedAt == null).toBe(true);
      expect(updated.reviewCompletedAt == null).toBe(true);
      expect(updated.metrics?.doneAt == null).toBe(true);
      expect(updated.metrics?.wallClockMs == null).toBe(true);
      // Steps reset to PENDING and stepsCompleted cleared.
      expect(updated.stepsCompleted).toEqual([]);
      expect(updated.implementationPlan[0].status).toBe('PENDING');

      // Authoritative state agrees.
      const stored = state.getTask('task-1');
      expect(stored?.status).toBe('WORKING');
      expect(stored?.reopenCount).toBe(1);
      expect(stored?.completedAt == null).toBe(true);
      expect(stored?.stepsCompleted).toEqual([]);
      expect(stored?.implementationPlan?.[0]?.status).toBe('PENDING');

      ws.close();
    });

    it('UPDATE_TASK strips daemon-owned fields (id, completedAt, reopenCount) from plugin payloads', async () => {
      const before = state.getTask('task-1');
      const originalCreatedAt = before?.createdAt;

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          updates: {
            // Legit field that should still apply:
            title: 'Renamed Task',
            // Denylisted fields that must be ignored:
            id: 'evil',
            completedAt: '2020-01-01T00:00:00.000Z',
            reopenCount: 99,
            metrics: { doneAt: '2020-01-01T00:00:00.000Z', wallClockMs: 1 },
            createdAt: '1999-01-01T00:00:00.000Z',
          },
        },
      }));

      const parsed = await nextTaskUpdated(nextMessage);
      const updated = parsed.payload;
      // The id never changed and the task is still resolvable by its real id.
      expect(updated.id).toBe('task-1');
      // Legit field applied.
      expect(updated.title).toBe('Renamed Task');
      // Denylisted fields untouched.
      expect(updated.completedAt == null).toBe(true);
      expect(updated.reopenCount).toBe(0);
      expect(updated.metrics?.doneAt == null).toBe(true);
      expect(updated.createdAt).toBe(originalCreatedAt);

      // No task created under the injected id.
      expect(state.getTask('evil')).toBeNull();
      const stored = state.getTask('task-1');
      expect(stored?.title).toBe('Renamed Task');
      expect(stored?.completedAt == null).toBe(true);
      expect(stored?.reopenCount).toBe(0);

      ws.close();
    });

    it('UPDATE_TASK strips the commit ledger and attribution/verification evidence from plugin payloads', async () => {
      const ledger = [{
        sha: 'abc1234abc1234', ref: 'moe/work-2026-08-28', kind: 'completion' as const, role: 'worker',
        sessionId: 'w@t', paths: ['src/a.ts'], pushed: true, recordedBy: 'worker-1', recordedAt: '2026-08-28T10:05:00.000Z',
      }];
      await state.updateTask('task-1', {
        commits: ledger,
        declaredFiles: ['src/decl.ts'],
        touchedFiles: ['src/touched.ts'],
        inferredPaths: ['src/inf.ts'],
        unattributedPaths: ['src/un.ts'],
        lastCommitOutcome: { outcome: 'committed', kind: 'completion', sessionId: 'w@t', at: '2026-08-28T10:05:00.000Z' },
        filesModified: ['src/fm.ts'],
        verification: { command: 'npm test', exitCode: 0, reportedAt: '2026-08-28T10:00:00.000Z' },
        reviewSummary: 'verified by QA',
      });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          updates: {
            title: 'Renamed Again',
            commits: [],
            declaredFiles: [],
            touchedFiles: [],
            inferredPaths: [],
            unattributedPaths: [],
            lastCommitOutcome: null,
            filesModified: ['evil.ts'],
            verification: { command: 'echo pwned', exitCode: 0, reportedAt: '2020-01-01T00:00:00.000Z' },
            reviewSummary: 'rubber stamp',
          },
        },
      }));

      const parsed = await nextTaskUpdated(nextMessage);
      expect(parsed.payload.title).toBe('Renamed Again');

      const stored = state.getTask('task-1')!;
      expect(stored.title).toBe('Renamed Again');
      expect(stored.commits).toEqual(ledger);
      expect(stored.declaredFiles).toEqual(['src/decl.ts']);
      expect(stored.touchedFiles).toEqual(['src/touched.ts']);
      expect(stored.inferredPaths).toEqual(['src/inf.ts']);
      expect(stored.unattributedPaths).toEqual(['src/un.ts']);
      expect(stored.lastCommitOutcome).toMatchObject({ outcome: 'committed', kind: 'completion' });
      expect(stored.filesModified).toEqual(['src/fm.ts']);
      expect(stored.verification?.command).toBe('npm test');
      expect(stored.reviewSummary).toBe('verified by QA');

      ws.close();
    });

    it('UPDATE_TASK strips the delivery-evidence label, so a board client cannot forge a verified delivery', async () => {
      const label = {
        kind: 'manual-artifact' as const,
        reference: 'Signed report at reports/q3.pdf',
        verifiedDelivery: false as const,
        recordedBy: 'qa-1',
        recordedAt: '2026-09-13T11:00:00.000Z',
      };
      await state.updateTask('task-1', { deliveryEvidence: label });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          updates: {
            title: 'Renamed Once More',
            deliveryEvidence: { ...label, reference: 'forged', verifiedDelivery: true },
          },
        },
      }));

      const parsed = await nextTaskUpdated(nextMessage);
      expect(parsed.payload.title).toBe('Renamed Once More');
      expect(state.getTask('task-1')!.deliveryEvidence).toEqual(label);

      ws.close();
    });

    it('UPDATE_TASK strips requiredCheckAtDone, so a board client cannot wipe the check a DONE task owes', async () => {
      await state.updateTask('task-1', { requiredCheckAtDone: 'node gate.cjs' });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { title: 'Renamed Yet Again', requiredCheckAtDone: null } },
      }));

      const parsed = await nextTaskUpdated(nextMessage);
      expect(parsed.payload.title).toBe('Renamed Yet Again');
      expect(state.getTask('task-1')!.requiredCheckAtDone).toBe('node gate.cjs');

      ws.close();
    });

    it('UPDATE_TASK drops forged plan-reuse state before it reaches state.updateTask', async () => {
      const spy = vi.spyOn(state, 'updateTask');
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT
      ws.send(JSON.stringify({ type: 'UPDATE_TASK', payload: { taskId: 'task-1', updates: { title: 'Renamed',
        planSourceBasis: { version: 1, commit: 'a'.repeat(40), planRevision: 0 },
        planningEntry: { from: 'BACKLOG', at: '2026-10-27T10:00:00.000Z', seq: 1 }, planReuse: null } } }));

      expect((await nextTaskUpdated(nextMessage)).payload.title).toBe('Renamed');
      expect(spy).toHaveBeenCalled();
      for (const [, updates] of spy.mock.calls) {
        for (const key of ['planSourceBasis', 'planningEntry', 'planReuse']) expect(Object.hasOwn(updates, key)).toBe(false);
      }
      const stored = state.getTask('task-1')!;
      expect([stored.planSourceBasis, stored.planningEntry, stored.planReuse]).toEqual([undefined, undefined, undefined]);
      ws.close();
    });

    it('UPDATE_TASK WORKING→REVIEW releases the worker even when the payload echoes the old owner', async () => {
      await state.createWorker({
        id: 'w-owner',
        type: 'CLAUDE',
        projectId: 'proj-test',
        epicId: 'epic-1',
        currentTaskId: 'task-1',
        status: 'CODING',
      });
      await state.updateTask('task-1', { status: 'WORKING', assignedWorkerId: 'w-owner' });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          // A full-task echo from a board client tries to carry the old owner
          // across the move — assignedWorkerId is denylisted, so the status
          // change must release the worker anyway.
          updates: { status: 'REVIEW', assignedWorkerId: 'w-owner' },
        },
      }));

      const parsed = await nextTaskUpdated(nextMessage);
      expect(parsed.payload.status).toBe('REVIEW');
      expect(parsed.payload.assignedWorkerId).toBeNull();

      const stored = state.getTask('task-1');
      expect(stored?.status).toBe('REVIEW');
      expect(stored?.assignedWorkerId).toBeNull();
      // The prior owner is fully released: pointer cleared AND back to IDLE.
      const worker = state.getWorker('w-owner');
      expect(worker?.currentTaskId).toBeNull();
      expect(worker?.status).toBe('IDLE');

      ws.close();
    });

    it('UPDATE_TASK out of BLOCKED keeps the reason and logs a real unblock', async () => {
      // 2026-09-11: a row carrying an unanswered PRODUCT_DECISION_REQUIRED block
      // was dragged out of BLOCKED twice. The board path nulled the whole block
      // record, so the next architect to claim it saw a clean PLANNING card with
      // no trace of the question and correctly re-blocked it three times. The
      // tool path already archives the prose into priorBlockedReason before
      // clearing; the board path must not be the one place it is destroyed.
      const REASON = 'PRODUCT_DECISION_REQUIRED: which installed policy is effective';
      await state.updateTask('task-1', {
        status: 'BLOCKED',
        blockedReason: REASON,
        blockedFromStatus: 'PLANNING',
        blockedAt: new Date().toISOString(),
      });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      // status + order together is the shape a card drag actually sends.
      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'PLANNING', order: 1011.4 } },
      }));

      const updated = (await nextTaskUpdated(nextMessage)).payload;
      expect(updated.status).toBe('PLANNING');
      // The OPERATIONAL fields still clear — a later grant or sweep must not
      // act on a block that is gone.
      expect(updated.blockedReason == null).toBe(true);
      expect(updated.blockedAt == null).toBe(true);
      expect(updated.blockedFromStatus == null).toBe(true);
      // The prose survives, which is the whole point: the next claimer can see
      // WHY it was parked and judge whether anything was actually decided.
      expect(updated.priorBlockedReason).toBe(REASON);

      const stored = state.getTask('task-1');
      expect(stored?.status).toBe('PLANNING');
      expect(stored?.priorBlockedReason).toBe(REASON);
      expect(stored?.blockedReason == null).toBe(true);

      // And the transition is named. A generic TASK_UPDATED told a reader
      // neither that a block had been cleared nor by what.
      const events = state.getActivityLog(50).filter((e) => e.taskId === 'task-1');
      const unblock = events.find((e) => e.event === 'TASK_UNBLOCKED');
      expect(unblock, 'board unblock must log TASK_UNBLOCKED, not a generic TASK_UPDATED').toBeDefined();

      // This block had no pending lease and no unmet prerequisite, so nothing
      // would ever have cleared it: the question is still open and the row
      // carries it forward where get_context will show the next claimer.
      expect(updated.reopenReason).toContain('UNANSWERED BLOCK');
      expect(updated.reopenReason).toContain(REASON);

      ws.close();
    });

    it('UPDATE_TASK out of a RESOURCE block carries no question forward', async () => {
      // A queued lease clears this row by itself when the grant fires, so a
      // manual exit loses nothing and a carried question would be noise.
      await state.updateTask('task-1', {
        status: 'BLOCKED',
        blockedReason: 'waiting on full-suite-gate for the daemon leg',
        blockedResourceId: 'full-suite-gate',
        blockedFromStatus: 'WORKING',
        blockedAt: new Date().toISOString(),
      });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage();

      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' } },
      }));

      const updated = (await nextTaskUpdated(nextMessage)).payload;
      expect(updated.status).toBe('WORKING');
      // Evidence still kept...
      expect(updated.priorBlockedReason).toBe('waiting on full-suite-gate for the daemon leg');
      // ...but not re-asked as an open question.
      expect(updated.reopenReason == null || !String(updated.reopenReason).includes('UNANSWERED BLOCK')).toBe(true);

      ws.close();
    });

    it('UPDATE_TASK out of a DEPENDENCY block carries no question while a prerequisite is unmet', async () => {
      // The dependency sweep restores this row when task-2 lands, so again
      // nothing is lost by a manual exit.
      const prereq = await state.createTask({
        epicId: 'epic-1',
        title: 'prerequisite still open',
        description: '',
        definitionOfDone: [],
        status: 'WORKING',
      });
      // Must be a LIVE task: isDependencySatisfied treats a missing id as
      // satisfied, so a fabricated id would invert what this arm measures.
      expect(state.getTask(prereq.id)?.status).toBe('WORKING');

      await state.updateTask('task-1', {
        status: 'BLOCKED',
        blockedReason: `BUILD-ORDER BLOCK on ${prereq.id}`,
        blockedOnTaskIds: [prereq.id],
        blockedFromStatus: 'WORKING',
        blockedAt: new Date().toISOString(),
      });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage();

      ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' } },
      }));

      const updated = (await nextTaskUpdated(nextMessage)).payload;
      expect(updated.status).toBe('WORKING');
      expect(updated.reopenReason == null || !String(updated.reopenReason).includes('UNANSWERED BLOCK')).toBe(true);

      ws.close();
    });

    it('RELEASE_TASK frees the task and idles the worker (board button path)', async () => {
      await state.createWorker({
        id: 'w-rel',
        type: 'CLAUDE',
        projectId: 'proj-test',
        epicId: 'epic-1',
        currentTaskId: 'task-1',
        status: 'CODING',
      });
      await state.updateTask('task-1', { status: 'WORKING', assignedWorkerId: 'w-rel' });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      ws.send(JSON.stringify({
        type: 'RELEASE_TASK',
        payload: { taskId: 'task-1', reason: 'human released from board' },
      }));

      const parsed = await nextTaskUpdated(nextMessage);
      // No steps done → released WORKING task stays WORKING, unassigned —
      // immediately re-claimable by the next worker.
      expect(parsed.payload.status).toBe('WORKING');
      expect(parsed.payload.assignedWorkerId).toBeNull();

      const stored = state.getTask('task-1');
      expect(stored?.status).toBe('WORKING');
      expect(stored?.assignedWorkerId).toBeNull();
      const worker = state.getWorker('w-rel');
      expect(worker?.currentTaskId).toBeNull();
      expect(worker?.status).toBe('IDLE');

      ws.close();
    });

    it('DEREGISTER_WORKER releases the seat and its task (IDE lost the terminal)', async () => {
      await state.createWorker({
        id: 'w-gone',
        type: 'CLAUDE',
        projectId: 'proj-test',
        epicId: 'epic-1',
        currentTaskId: 'task-1',
        status: 'CODING',
      });
      await state.updateTask('task-1', { status: 'WORKING', assignedWorkerId: 'w-gone' });

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage(); // STATE_SNAPSHOT

      async function nextAck() {
        for (;;) {
          const parsed = JSON.parse(await nextMessage());
          if (parsed.type === 'ERROR') throw new Error(`Unexpected ERROR: ${parsed.message}`);
          if (parsed.type === 'WORKER_DEREGISTERED') return parsed.payload;
        }
      }

      ws.send(JSON.stringify({ type: 'DEREGISTER_WORKER', payload: { workerId: 'w-gone', reason: 'terminal_closed' } }));
      expect(await nextAck()).toEqual({ workerId: 'w-gone', alreadyDead: false, releasedTaskIds: ['task-1'] });
      // No steps done → the released WORKING row stays WORKING, unassigned.
      expect(state.getTask('task-1')?.status).toBe('WORKING');
      expect(state.getTask('task-1')?.assignedWorkerId).toBeNull();
      expect(state.getWorker('w-gone')?.status).toBe('DEAD');

      // Idempotent, and quiet for a record the startup purge already removed:
      // the IDE re-sends at every connect until one is acked.
      ws.send(JSON.stringify({ type: 'DEREGISTER_WORKER', payload: { workerId: 'w-gone' } }));
      expect(await nextAck()).toEqual({ workerId: 'w-gone', alreadyDead: true, releasedTaskIds: [] });
      ws.send(JSON.stringify({ type: 'DEREGISTER_WORKER', payload: { workerId: 'w-never-existed' } }));
      expect(await nextAck()).toEqual({ workerId: 'w-never-existed', alreadyDead: true, releasedTaskIds: [] });

      ws.close();
    });

    it('caps and truncates GET_ACTIVITY_LOG responses', async () => {
      const logPath = path.join(moePath, 'activity.log');
      for (let i = 0; i < 120; i++) {
        fs.appendFileSync(logPath, JSON.stringify({
          id: `evt-ws-${i}`,
          timestamp: new Date(Date.now() + i).toISOString(),
          projectId: 'proj-test',
          event: 'TASK_UPDATED',
          payload: { bigField: 'x'.repeat(5000), index: i },
        }) + '\n');
      }

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage();

      ws.send(JSON.stringify({ type: 'GET_ACTIVITY_LOG', payload: { limit: 999999, maxPayloadChars: 999999 } }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ACTIVITY_LOG');
      expect(parsed.payload.length).toBeLessThanOrEqual(100);
      expect(parsed.payload[0].payload.bigField.length).toBeLessThanOrEqual(2020);
      expect(parsed.payload[0].payload.bigField).toContain('[truncated]');

      ws.send(JSON.stringify({ type: 'GET_ACTIVITY_LOG', payload: { limit: 1, maxPayloadChars: 0 } }));
      const zeroCapResponse = await nextMessage();
      const zeroCapParsed = JSON.parse(zeroCapResponse);
      expect(zeroCapParsed.type).toBe('ACTIVITY_LOG');
      expect(zeroCapParsed.payload).toHaveLength(1);
      expect(zeroCapParsed.payload[0].payload.bigField.length).toBeLessThanOrEqual(520);
      expect(zeroCapParsed.payload[0].payload.bigField).toContain('[truncated]');

      ws.close();
    });

    it('returns epic lifecycle activity from GET_ACTIVITY_LOG newest-first', async () => {
      const epic = await state.createEpic({ title: 'WS Epic', status: 'ACTIVE', order: 2 });
      await state.updateEpic(epic.id, { title: 'WS Epic Updated', order: 3 });
      await state.flushActivityLog();

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage();

      ws.send(JSON.stringify({
        type: 'GET_ACTIVITY_LOG',
        payload: {
          epicId: epic.id,
          eventTypes: ['EPIC_CREATED', 'EPIC_UPDATED'],
          limit: 10,
          maxPayloadChars: 0,
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ACTIVITY_LOG');
      expect(parsed.payload.map((event: { event: string }) => event.event)).toEqual(['EPIC_UPDATED', 'EPIC_CREATED']);
      expect(parsed.payload.every((event: { epicId?: string }) => event.epicId === epic.id)).toBe(true);

      ws.close();
    });

    it('rejects ADD_TASK_COMMENT payloads over 10K characters', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      ws.send(JSON.stringify({
        type: 'ADD_TASK_COMMENT',
        payload: {
          taskId: 'task-1',
          content: 'x'.repeat(10_001),
          author: 'human',
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.message).toContain('10000');

      ws.close();
    });

    it('returns an ERROR for invalid settings updates without persisting them', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      await nextMessage();

      ws.send(JSON.stringify({
        type: 'UPDATE_SETTINGS',
        payload: {
          approvalMode: 'CHAOS',
          agentCommand: 'codex',
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.message).toContain('approvalMode');
      expect(state.project?.settings.approvalMode).toBe('CONTROL');
      expect(state.project?.settings.agentCommand).toBe('claude');

      ws.close();
    });

    it('returns an ERROR for invalid team updates without persisting them', async () => {
      const team = await state.createTeam({ name: 'Workers', role: 'worker', maxSize: 2 });
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      await nextMessage();

      ws.send(JSON.stringify({
        type: 'UPDATE_TEAM',
        payload: {
          teamId: team.id,
          updates: {
            memberIds: ['worker-1', 'worker-1'],
            name: 'Should Not Persist',
          },
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.message).toContain('memberIds');
      expect(state.getTeam(team.id)?.name).toBe('Workers');

      ws.close();
    });

    it('returns an ERROR for immutable CREATE_TEAM fields without creating a team', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      await nextMessage();

      ws.send(JSON.stringify({
        type: 'CREATE_TEAM',
        payload: {
          id: 'team-evil',
          name: 'Injected Team',
          role: 'worker',
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.message).toContain('id');
      expect(state.getTeamByName('Injected Team')).toBeNull();

      ws.close();
    });

    it('sends DAEMON_SHUTTING_DOWN before closing plugin connections', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      const socketClosed = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });

      const closePromise = wsServer.close();
      const shutdownMessage = await nextMessage();
      const parsed = JSON.parse(shutdownMessage);

      expect(parsed.type).toBe('DAEMON_SHUTTING_DOWN');

      await closePromise;
      await socketClosed;
    });
  });

  describe('MCP endpoint (/mcp)', () => {
    async function waitUntil(
      predicate: () => boolean,
      description: string,
      timeoutMs = 1000
    ): Promise<void> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${description}`);
    }

    it('handles tools/list request', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);

      await new Promise<void>((resolve) => {
        ws.on('open', () => resolve());
      });

      // Send MCP request
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }));

      const response = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(1);
      expect(parsed.result.tools).toBeDefined();
      expect(Array.isArray(parsed.result.tools)).toBe(true);

      ws.close();
    });

    it('handles tools/call request', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);

      await new Promise<void>((resolve) => {
        ws.on('open', () => resolve());
      });

      // Call list_tasks tool
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'moe.list_tasks',
          arguments: {},
        },
      }));

      const response = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(2);
      expect(parsed.result).toBeDefined();

      // Parse the content
      const content = JSON.parse(parsed.result.content[0].text);
      expect(content.tasks.length).toBe(1);
      expect(content.tasks[0].id).toBe('task-1');

      ws.close();
    });

    it('does not start later batched waiters after the MCP socket closes mid-batch', async () => {
      const workerId = 'worker-batch-close';
      const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      ws.send(JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 'wait',
          method: 'tools/call',
          params: {
            name: 'moe.wait_for_task',
            arguments: { statuses: ['WORKING'], workerId, timeoutMs: 60_000 },
          },
        },
        {
          jsonrpc: '2.0',
          id: 'chat',
          method: 'tools/call',
          params: {
            name: 'moe.chat_wait',
            arguments: { workerId, timeoutMs: 60_000 },
          },
        },
      ]));

      await waitUntil(() => activeWaiters.has(workerId), 'wait_for_task waiter registration');

      const closed = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });
      ws.close();
      await closed;

      await waitUntil(() => !activeWaiters.has(workerId), 'wait_for_task disconnect cleanup');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(activeWaiters.has(workerId)).toBe(false);
      expect(activeChatWaiters.has(workerId)).toBe(false);
    });

    it('tracks worker IDs from batched tools/call requests for disconnect cleanup', async () => {
      const waitResolve = vi.fn();
      const waitUnsubscribe = vi.fn();
      const waitTimer = setTimeout(() => {}, 60_000);
      activeWaiters.set('worker-batch-wait', {
        resolve: waitResolve,
        unsubscribe: waitUnsubscribe,
        timer: waitTimer,
      });

      const chatResolve = vi.fn();
      const chatUnsubscribe = vi.fn();
      const chatTimer = setTimeout(() => {}, 60_000);
      activeChatWaiters.set('worker-batch-chat', {
        resolve: chatResolve,
        unsubscribe: chatUnsubscribe,
        timer: chatTimer,
        channels: null,
      });

      const fakeWs = {} as WebSocket;
      const internals = wsServer as unknown as {
        trackMcpWorker(ws: WebSocket, request: unknown): void;
        registerMcpWaiter(ws: WebSocket, toolName: string, workerId: string): void;
        cleanupMcpWorkers(ws: WebSocket): Promise<void>;
        mcpWorkerMap: Map<WebSocket, Set<string>>;
      };

      internals.trackMcpWorker(fakeWs, [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'moe.wait_for_task', arguments: { workerId: 'worker-batch-wait' } },
        },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'moe.chat_wait', arguments: { workerId: 'worker-batch-chat' } },
        },
      ]);

      expect(internals.mcpWorkerMap.get(fakeWs)).toEqual(new Set(['worker-batch-wait', 'worker-batch-chat']));
      // Publishing the waiters, rather than merely parsing the batch, owns them.
      internals.registerMcpWaiter(fakeWs, 'moe.wait_for_task', 'worker-batch-wait');
      internals.registerMcpWaiter(fakeWs, 'moe.chat_wait', 'worker-batch-chat');

      await internals.cleanupMcpWorkers(fakeWs);

      expect(activeWaiters.has('worker-batch-wait')).toBe(false);
      expect(waitUnsubscribe).toHaveBeenCalledTimes(1);
      expect(waitResolve).toHaveBeenCalledWith({ hasNext: false, cancelled: true });
      expect(activeChatWaiters.has('worker-batch-chat')).toBe(false);
      expect(chatUnsubscribe).toHaveBeenCalledTimes(1);
      expect(chatResolve).toHaveBeenCalledWith({ hasMessage: false, cancelled: true });
    });
  });

  describe('Error handling', () => {
    it('allows repeated close calls without throwing', async () => {
      await wsServer.close();
      await expect(wsServer.close()).resolves.toBeUndefined();
    });

    it('survives rapid client connect/disconnect cycles', async () => {
      // Simulate multiple rapid connections and disconnections
      // This exercises the error handlers for abrupt disconnects
      for (let i = 0; i < 3; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await new Promise<void>((resolve) => {
          ws.on('open', () => resolve());
          ws.on('error', () => resolve()); // Ignore connection errors
        });
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
      }

      // Server should still work after rapid disconnects
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const message = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(message);
      expect(parsed.type).toBe('STATE_SNAPSHOT');
      ws.close();
    });

    it('handles invalid JSON gracefully', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages: string[] = [];
      let waiting: ((msg: string) => void) | null = null;

      ws.on('message', (data) => {
        const msg = data.toString();
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(msg);
        } else {
          messages.push(msg);
        }
      });

      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      function nextMessage(timeoutMs = 5000): Promise<string> {
        if (messages.length > 0) return Promise.resolve(messages.shift()!);
        return new Promise<string>((resolve, reject) => {
          waiting = resolve;
          setTimeout(() => { waiting = null; reject(new Error('Timeout')); }, timeoutMs);
        });
      }

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      // Send invalid JSON - should not crash server
      ws.send('not valid json');

      // Server responds with ERROR for invalid JSON, then we send PING
      // Consume the ERROR response first
      const errorMsg = await nextMessage();
      const errorParsed = JSON.parse(errorMsg);
      expect(errorParsed.type).toBe('ERROR');

      // Server should still respond to valid messages
      ws.send(JSON.stringify({ type: 'PING' }));

      const response = await nextMessage();

      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('PONG');

      ws.close();
    });
  });
});

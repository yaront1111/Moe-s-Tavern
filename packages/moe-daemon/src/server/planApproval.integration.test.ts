// =============================================================================
// Plan-approval freshness — CROSS-LAYER integration tests.
//
// Scope discipline: the six slices of this feature each own their own matrix
// (submitPlan.test.ts for the producer, src/server/planApproval.test.ts for the
// daemon compare-and-swap, PlanApprovalContractTest + PlanReviewApprovalStateTest
// for JetBrains, plan-approval-client + plan-review for VS Code). NOTHING here
// re-runs those. What lives here is only what no single slice could own: two live
// sockets at once (a plugin reviewer on /ws and an agent on /mcp), all THREE
// writers that advance the stamp (submit_plan, amend_plan_step, a plugin
// UPDATE_TASK edit), the one-bump rule measured end to end across those writers,
// durability across a daemon restart, and a legacy stamp-less row invalidated by
// a wire edit.
//
// Everything runs against production paths: a real http server on port 0, a real
// StateManager over a disposable temp project, a real McpAdapter, a real
// MoeWebSocketServer and genuine ws clients, under CONTROL approval mode. No
// private handler is ever called and no two direct calls are raced; the only
// non-socket reads are `state.getTask` and the activity log, which are what any
// reader sees.
//
// Error handling is the point here, not an afterthought: every refusal (stale
// token, malformed token, forged stamp), the disconnected client and the
// teardown path each assert a concrete observable outcome.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter } from './McpAdapter.js';
import { clearAllSpeedModeTimeouts } from '../tools/submitPlan.js';

/** MoeErrorCode.STATE_CONFLICT / MoeErrorCode.INVALID_INPUT, as they reach a client. */
const STATE_CONFLICT_CODE = -32002;
const INVALID_INPUT_CODE = -32602;

/** An architect-prefixed id — util/workerRole resolves the role gate from the prefix. */
const ARCHITECT_ID = 'architect-integration';

interface McpCallResponse {
  id: number;
  result?: { content: Array<{ type: string; text: string }> };
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

type Frame = Record<string, unknown>;

interface PluginClient {
  ws: WebSocket;
  send(message: Record<string, unknown>): void;
  nextFrame(match: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  nextOfType(type: string, match?: (payload: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
}

describe('plan-approval freshness across sockets, writers and restarts', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  let mcpAdapter: McpAdapter;
  let httpServer: Server | null;
  let wsServer: MoeWebSocketServer | null;
  let port = 0;
  let openClients: WebSocket[];

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  function setupMoeFolder(settingsOverrides: Record<string, unknown> = {}): void {
    fs.mkdirSync(moePath, { recursive: true });
    for (const dir of ['epics', 'tasks', 'workers', 'proposals']) {
      fs.mkdirSync(path.join(moePath, dir), { recursive: true });
    }
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
        autoCreateBranch: false,
        agentCommand: 'claude',
        ...settingsOverrides,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  function createEpic(id = 'epic-1'): void {
    const epic = {
      id,
      projectId: 'proj-test',
      title: 'Test Epic',
      description: '',
      architectureNotes: '',
      epicRails: [],
      status: 'ACTIVE',
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', `${id}.json`), JSON.stringify(epic, null, 2));
  }

  /**
   * Write a raw task record. `omitPlanRevision` produces a faithful LEGACY row —
   * a JSON file with no `planRevision` key at all, which is what a pre-feature
   * daemon left on disk. StateManager.load reads raw entities, so it survives.
   */
  function writeTask(
    overrides: Record<string, unknown> = {},
    opts: { omitPlanRevision?: boolean } = {}
  ): void {
    const id = (overrides.id as string) ?? 'task-1';
    const task: Record<string, unknown> = {
      id,
      epicId: 'epic-1',
      title: 'Test Task',
      description: '',
      definitionOfDone: ['Original DoD'],
      taskRails: [],
      implementationPlan: [
        { stepId: 'step-1', description: 'Step 1', status: 'PENDING', affectedFiles: [] },
      ],
      status: 'AWAITING_APPROVAL',
      assignedWorkerId: null,
      branch: null,
      prLink: null,
      reopenCount: 0,
      reopenReason: null,
      createdBy: 'HUMAN',
      parentTaskId: null,
      order: 1,
      planRevision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    if (opts.omitPlanRevision) delete task.planRevision;
    fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify(task, null, 2));
  }

  function taskBytes(id = 'task-1'): string {
    return fs.readFileSync(path.join(moePath, 'tasks', `${id}.json`), 'utf-8');
  }

  function revisionOf(id = 'task-1'): number | undefined {
    return state.getTask(id)?.planRevision;
  }

  /** Boot a daemon over the CURRENT temp project. Called again after stop() to prove durability. */
  async function start(): Promise<void> {
    state = new StateManager({ projectPath: testDir });
    await state.load();
    mcpAdapter = new McpAdapter(state);
    httpServer = createServer();
    await new Promise<void>((resolve) => {
      httpServer!.listen(0, '127.0.0.1', () => {
        const address = httpServer!.address();
        if (address && typeof address === 'object') port = address.port;
        resolve();
      });
    });
    wsServer = new MoeWebSocketServer(httpServer, state, mcpAdapter);
  }

  /** Close every client, the ws server and the http server. Safe to call twice. */
  async function stop(): Promise<void> {
    for (const client of openClients) {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close();
      }
    }
    openClients = [];
    if (wsServer && !wsServer.closed) await wsServer.close();
    wsServer = null;
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }

  // ---------------------------------------------------------------------------
  // Clients
  // ---------------------------------------------------------------------------

  /**
   * A plugin client on /ws. The server pushes a STATE_SNAPSHOT on connect, which
   * this consumes before returning so a later read is never the connect-time one.
   * Frames are matched by CONTENT, not arrival order: every write produces both a
   * reply and a broadcast, so order-based reads are inherently flaky here.
   */
  async function connectPlugin(): Promise<PluginClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    openClients.push(ws);
    const buffered: string[] = [];
    let waiting: ((msg: string) => void) | null = null;
    ws.on('message', (data) => {
      const msg = data.toString();
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(msg);
      } else {
        buffered.push(msg);
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    function nextMessage(timeoutMs: number): Promise<string> {
      if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
      return new Promise<string>((resolve, reject) => {
        // The timer is cleared on delivery: one dangling 5s timeout per frame
        // read would keep this worker's event loop busy well past the test that
        // armed it, which is how a green suite still hangs a CI worker.
        const timer = setTimeout(() => {
          if (waiting === deliver) waiting = null;
          reject(new Error('Timed out waiting for a /ws frame'));
        }, timeoutMs);
        const deliver = (msg: string): void => {
          clearTimeout(timer);
          resolve(msg);
        };
        waiting = deliver;
      });
    }

    async function nextFrame(match: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Timed out waiting for a matching /ws frame');
        const parsed = JSON.parse(await nextMessage(remaining)) as Frame;
        if (match(parsed)) return parsed;
      }
    }

    function nextOfType(
      type: string,
      match?: (payload: Frame) => boolean,
      timeoutMs = 5000
    ): Promise<Frame> {
      return nextFrame(
        (frame) => frame.type === type && (!match || match((frame.payload ?? {}) as Frame)),
        timeoutMs
      );
    }

    const client: PluginClient = {
      ws,
      send: (message) => ws.send(JSON.stringify(message)),
      nextFrame,
      nextOfType,
    };
    await nextOfType('STATE_SNAPSHOT');
    return client;
  }

  /** An agent client on /mcp, speaking the same JSON-RPC the proxy speaks. */
  function connectMcp(): {
    ws: WebSocket;
    ready: Promise<void>;
    call: (name: string, args: Record<string, unknown>) => Promise<McpCallResponse>;
  } {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    openClients.push(ws);
    const pending = new Map<number, (value: McpCallResponse) => void>();
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as McpCallResponse;
      const resolve = pending.get(parsed.id);
      if (resolve) {
        pending.delete(parsed.id);
        resolve(parsed);
      }
    });
    const ready = new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    let nextId = 1;
    function call(
      name: string,
      args: Record<string, unknown>,
      timeoutMs = 5000
    ): Promise<McpCallResponse> {
      const id = nextId++;
      return new Promise<McpCallResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out calling ${name}`));
        }, timeoutMs);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        ws.send(
          JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
        );
      });
    }
    return { ws, ready, call };
  }

  function okResult(response: McpCallResponse): Record<string, unknown> {
    expect(response.error).toBeUndefined();
    const text = response.result?.content?.[0]?.text;
    expect(typeof text).toBe('string');
    return JSON.parse(text as string) as Record<string, unknown>;
  }

  // ---------------------------------------------------------------------------
  // Wire helpers
  // ---------------------------------------------------------------------------

  /** The revision a reviewing client would render, read the way a plugin reads it. */
  async function snapshotRevision(client: PluginClient, taskId = 'task-1'): Promise<number | undefined> {
    client.send({ type: 'GET_STATE' });
    const frame = await client.nextOfType('STATE_SNAPSHOT');
    const tasks = ((frame.payload ?? {}) as { tasks?: Array<Record<string, unknown>> }).tasks ?? [];
    return tasks.find((t) => t.id === taskId)?.planRevision as number | undefined;
  }

  function approveFrame(taskId: string, token?: unknown): Record<string, unknown> {
    const payload: Record<string, unknown> = { taskId };
    // Omission is the ONLY legacy opt-out, so `undefined` must leave the key out
    // entirely — while an explicit null still travels, and is malformed.
    if (token !== undefined) payload.expectedPlanRevision = token;
    return { type: 'APPROVE_TASK', payload };
  }

  async function expectApproved(client: PluginClient, taskId = 'task-1'): Promise<void> {
    const accepted = await client.nextOfType(
      'TASK_UPDATED',
      (payload) => payload.id === taskId && payload.status === 'WORKING'
    );
    expect((accepted.payload as { planApprovedAt?: string }).planApprovedAt).toEqual(expect.any(String));
    expect(state.getTask(taskId)?.status).toBe('WORKING');
  }

  async function expectStaleRefusal(
    client: PluginClient,
    opts: { taskId?: string; sent: number; current: number; operation: string }
  ): Promise<void> {
    const taskId = opts.taskId ?? 'task-1';
    const refused = await client.nextOfType('ERROR');
    expect(refused.code).toBe(STATE_CONFLICT_CODE);
    expect(refused.codeName).toBe('PLAN_REVISION_MISMATCH');
    expect(refused.operation).toBe(opts.operation);
    expect(refused.context).toEqual({
      taskId,
      expectedPlanRevision: opts.sent,
      currentPlanRevision: opts.current,
    });
    expect(state.getTask(taskId)?.status).toBe('AWAITING_APPROVAL');
  }

  async function expectNoApprovalEvent(taskId = 'task-1'): Promise<void> {
    await state.flushActivityLog();
    const approvals = state
      .getActivityLog(200)
      .filter(
        (e) => e.taskId === taskId && (e.event === 'PLAN_APPROVED' || e.event === 'PLAN_AUTO_APPROVED')
      );
    expect(approvals).toEqual([]);
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plan-freshness-'));
    moePath = path.join(testDir, '.moe');
    httpServer = null;
    wsServer = null;
    openClients = [];
  });

  afterEach(async () => {
    // Timers first: a pending SPEED callback outliving this file would approve a
    // sibling file's task. Then sockets, then the servers, then ONLY the temp
    // directory this test owns (retried, because Windows holds the last handle
    // for a beat after close).
    clearAllSpeedModeTimeouts();
    try {
      await stop();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  // ---------------------------------------------------------------------------
  // (1) Two sockets, three writers: a reviewer's snapshot vs a concurrent writer
  // ---------------------------------------------------------------------------

  describe('a plugin reviewer against a concurrent writer', () => {
    it('refuses the rendered revision after a newer plan is submitted over /mcp, then accepts the refreshed one', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ status: 'PLANNING', planRevision: 0 });
      await start();
      const agent = connectMcp();
      await agent.ready;
      const reviewer = await connectPlugin();

      okResult(
        await agent.call('moe.submit_plan', {
          taskId: 'task-1',
          steps: [{ description: 'First plan' }],
          workerId: ARCHITECT_ID,
        })
      );
      const rendered = await snapshotRevision(reviewer);
      expect(rendered).toBe(1);

      // The human bounces it back over the board socket — a status-only write,
      // which must NOT advance the stamp — and the architect resubmits over MCP.
      reviewer.send({ type: 'UPDATE_TASK', payload: { taskId: 'task-1', updates: { status: 'PLANNING' } } });
      await reviewer.nextOfType('TASK_UPDATED', (p) => p.status === 'PLANNING');
      expect(revisionOf()).toBe(1);

      okResult(
        await agent.call('moe.submit_plan', {
          taskId: 'task-1',
          steps: [{ description: 'Second plan, materially different' }],
          workerId: ARCHITECT_ID,
        })
      );
      expect(revisionOf()).toBe(2);

      const bytesBefore = taskBytes();
      reviewer.send(approveFrame('task-1', rendered));
      await expectStaleRefusal(reviewer, { sent: 1, current: 2, operation: 'APPROVE_TASK' });
      expect(taskBytes()).toBe(bytesBefore);
      expect(state.getTask('task-1')?.assignedWorkerId).toBeNull();
      expect(state.getTask('task-1')?.planApprovedAt).toBeUndefined();
      await expectNoApprovalEvent();

      // Refreshing is the whole point of the refusal.
      const refreshed = await snapshotRevision(reviewer);
      expect(refreshed).toBe(2);
      reviewer.send(approveFrame('task-1', refreshed));
      await expectApproved(reviewer);
    });

    it('refuses the rendered revision after a real amend_plan_step over /mcp', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 3 });
      await start();
      const agent = connectMcp();
      await agent.ready;
      const reviewer = await connectPlugin();

      const rendered = await snapshotRevision(reviewer);
      expect(rendered).toBe(3);

      okResult(
        await agent.call('moe.amend_plan_step', {
          taskId: 'task-1',
          stepId: 'step-1',
          description: 'Rewritten step instructions',
          reason: 'sharpened after review',
          workerId: ARCHITECT_ID,
        })
      );
      expect(revisionOf()).toBe(4);

      reviewer.send(approveFrame('task-1', rendered));
      await expectStaleRefusal(reviewer, { sent: 3, current: 4, operation: 'APPROVE_TASK' });
      await expectNoApprovalEvent();

      reviewer.send(approveFrame('task-1', 4));
      await expectApproved(reviewer);
    });

    it('refuses a rendered revision invalidated by another plugin client editing the Definition of Done', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 5 });
      await start();
      const reviewer = await connectPlugin();
      const editor = await connectPlugin();

      const rendered = await snapshotRevision(reviewer);
      expect(rendered).toBe(5);

      editor.send({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { definitionOfDone: ['A brand new acceptance item'] } },
      });
      await editor.nextOfType('TASK_UPDATED', (p) => p.planRevision === 6);
      expect(revisionOf()).toBe(6);

      reviewer.send(approveFrame('task-1', rendered));
      await expectStaleRefusal(reviewer, { sent: 5, current: 6, operation: 'APPROVE_TASK' });
      await expectNoApprovalEvent();

      reviewer.send(approveFrame('task-1', 6));
      await expectApproved(reviewer);
    });

    it('refuses a stale token on the UPDATE_TASK drag route too, then accepts the current one', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 2 });
      await start();
      const agent = connectMcp();
      await agent.ready;
      const reviewer = await connectPlugin();

      okResult(
        await agent.call('moe.amend_plan_step', {
          taskId: 'task-1',
          stepId: 'step-1',
          description: 'Amended again',
          reason: 'governor feedback',
          workerId: ARCHITECT_ID,
        })
      );
      expect(revisionOf()).toBe(3);

      reviewer.send({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' }, expectedPlanRevision: 2 },
      });
      await expectStaleRefusal(reviewer, { sent: 2, current: 3, operation: 'UPDATE_TASK' });
      await expectNoApprovalEvent();

      reviewer.send({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' }, expectedPlanRevision: 3 },
      });
      await expectApproved(reviewer);
    });
  });

  // ---------------------------------------------------------------------------
  // (2) One bump per write, measured across all three writers
  // ---------------------------------------------------------------------------

  describe('the one-bump rule, end to end', () => {
    it('advances exactly once when a single write changes both the steps and the Definition of Done', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 2 });
      await start();
      const editor = await connectPlugin();

      editor.send({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          updates: {
            definitionOfDone: ['Both surfaces changed'],
            implementationPlan: [
              { stepId: 'step-1', description: 'Replaced step', status: 'PENDING', affectedFiles: [] },
            ],
          },
        },
      });
      await editor.nextOfType('TASK_UPDATED', (p) => p.id === 'task-1');
      expect(revisionOf()).toBe(3);
    });

    it('advances exactly once for a byte-identical full resubmit over /mcp', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ status: 'PLANNING', planRevision: 0 });
      await start();
      const agent = connectMcp();
      await agent.ready;
      const reviewer = await connectPlugin();
      const steps = [{ description: 'Exactly the same plan text' }];

      okResult(await agent.call('moe.submit_plan', { taskId: 'task-1', steps, workerId: ARCHITECT_ID }));
      expect(revisionOf()).toBe(1);

      reviewer.send({ type: 'UPDATE_TASK', payload: { taskId: 'task-1', updates: { status: 'PLANNING' } } });
      await reviewer.nextOfType('TASK_UPDATED', (p) => p.status === 'PLANNING');
      expect(revisionOf()).toBe(1);

      okResult(await agent.call('moe.submit_plan', { taskId: 'task-1', steps, workerId: ARCHITECT_ID }));
      expect(revisionOf()).toBe(2);
    });

    it('does not advance for an equal sanitized edit, and the rendered token still approves', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 4 });
      await start();
      const reviewer = await connectPlugin();
      const editor = await connectPlugin();

      const rendered = await snapshotRevision(reviewer);
      expect(rendered).toBe(4);
      const current = state.getTask('task-1')!;

      editor.send({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          updates: {
            definitionOfDone: current.definitionOfDone,
            implementationPlan: current.implementationPlan,
          },
        },
      });
      await editor.nextOfType('TASK_UPDATED', (p) => p.id === 'task-1');
      expect(revisionOf()).toBe(4);

      reviewer.send(approveFrame('task-1', rendered));
      await expectApproved(reviewer);
    });

    it('does not advance for a comments-only change, and the rendered token still approves', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 6 });
      await start();
      const agent = connectMcp();
      await agent.ready;
      const reviewer = await connectPlugin();

      const rendered = await snapshotRevision(reviewer);
      expect(rendered).toBe(6);

      okResult(
        await agent.call('moe.add_comment', {
          taskId: 'task-1',
          content: 'A reviewer question that changes no plan surface',
          workerId: ARCHITECT_ID,
        })
      );
      expect(revisionOf()).toBe(6);
      expect(state.getTask('task-1')?.comments?.length).toBe(1);

      reviewer.send(approveFrame('task-1', rendered));
      await expectApproved(reviewer);
    });
  });

  // ---------------------------------------------------------------------------
  // (3) Durability and backwards compatibility
  // ---------------------------------------------------------------------------

  describe('durability and backwards compatibility', () => {
    it('keeps the revision across a daemon restart: the reloaded value approves and the pre-restart one does not', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 1 });
      await start();
      const agent = connectMcp();
      await agent.ready;
      okResult(
        await agent.call('moe.amend_plan_step', {
          taskId: 'task-1',
          stepId: 'step-1',
          description: 'Amended before the restart',
          reason: 'so the stamp has to survive a reload',
          workerId: ARCHITECT_ID,
        })
      );
      expect(revisionOf()).toBe(2);

      await stop();
      await start();
      const reviewer = await connectPlugin();

      const reloaded = await snapshotRevision(reviewer);
      expect(reloaded).toBe(2);

      reviewer.send(approveFrame('task-1', 1));
      await expectStaleRefusal(reviewer, { sent: 1, current: 2, operation: 'APPROVE_TASK' });

      reviewer.send(approveFrame('task-1', reloaded));
      await expectApproved(reviewer);
    });

    it('still approves a legacy stamp-less row when the client omits the token entirely', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({}, { omitPlanRevision: true });
      await start();
      expect(revisionOf()).toBeUndefined();
      const reviewer = await connectPlugin();

      reviewer.send(approveFrame('task-1'));
      await expectApproved(reviewer);
    });

    it('moves a legacy stamp-less row off the effective 0 as soon as a wire edit changes the plan', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({}, { omitPlanRevision: true });
      await start();
      const reviewer = await connectPlugin();
      const editor = await connectPlugin();

      // A stamp-less row carries no revision on the wire; a legacy client sends 0.
      expect(await snapshotRevision(reviewer)).toBeUndefined();

      editor.send({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { definitionOfDone: ['Edited after the legacy era'] } },
      });
      await editor.nextOfType('TASK_UPDATED', (p) => p.id === 'task-1');
      expect(revisionOf()).toBe(1);

      reviewer.send(approveFrame('task-1', 0));
      await expectStaleRefusal(reviewer, { sent: 0, current: 1, operation: 'APPROVE_TASK' });
      await expectNoApprovalEvent();

      reviewer.send(approveFrame('task-1', 1));
      await expectApproved(reviewer);
    });
  });

  // ---------------------------------------------------------------------------
  // (4) Malformed tokens, forged stamps, a client that goes away, and a race
  // ---------------------------------------------------------------------------

  describe('malformed tokens, forged stamps and clients that vanish', () => {
    it('refuses a numeric-looking STRING token with INVALID_INPUT and leaks no revision numbers', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 3 });
      await start();
      const reviewer = await connectPlugin();
      const bytesBefore = taskBytes();

      reviewer.send(approveFrame('task-1', '3'));
      const refused = await reviewer.nextOfType('ERROR');
      expect(refused.code).toBe(INVALID_INPUT_CODE);
      expect(refused.codeName).toBe('INVALID_INPUT');
      expect(refused.operation).toBe('APPROVE_TASK');
      expect(refused.context).toEqual({ taskId: 'task-1' });
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
      expect(taskBytes()).toBe(bytesBefore);
      await expectNoApprovalEvent();

      reviewer.send(approveFrame('task-1', 3));
      await expectApproved(reviewer);
    });

    it('strips a forged planRevision from a patch that legitimately changes the plan, and the derived bump wins', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 7 });
      await start();
      const editor = await connectPlugin();
      const reviewer = await connectPlugin();

      editor.send({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          updates: {
            definitionOfDone: ['A real edit riding with a forged stamp'],
            planRevision: 99,
            expectedPlanRevision: 99,
          },
        },
      });
      await editor.nextOfType('TASK_UPDATED', (p) => p.id === 'task-1');
      expect(revisionOf()).toBe(8);
      const persisted = JSON.parse(taskBytes()) as Record<string, unknown>;
      expect(persisted.planRevision).toBe(8);
      expect(persisted.expectedPlanRevision).toBeUndefined();

      reviewer.send(approveFrame('task-1', 99));
      await expectStaleRefusal(reviewer, { sent: 99, current: 8, operation: 'APPROVE_TASK' });

      reviewer.send(approveFrame('task-1', 8));
      await expectApproved(reviewer);
    });

    it('survives a reviewer that disconnects immediately after a refused approval', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 2 });
      await start();
      const leaver = await connectPlugin();
      const bytesBefore = taskBytes();

      // Send a stale token and drop the socket before the reply can be delivered:
      // the daemon must neither approve nor wedge on the unwritable client.
      leaver.send(approveFrame('task-1', 1));
      leaver.ws.close();
      await new Promise<void>((resolve) => leaver.ws.on('close', () => resolve()));

      const survivor = await connectPlugin();
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
      expect(taskBytes()).toBe(bytesBefore);
      await expectNoApprovalEvent();

      survivor.send(approveFrame('task-1', 2));
      await expectApproved(survivor);
    });

    it('resolves a newer write racing an older approval into exactly one consistent outcome', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 1 });
      await start();
      const agent = connectMcp();
      await agent.ready;
      const reviewer = await connectPlugin();

      // Both frames go out with no await in between. The state mutex picks an
      // order; only two outcomes are consistent with it, and BOTH are asserted
      // strictly — nothing here depends on which one the mutex chooses.
      const amending = agent.call('moe.amend_plan_step', {
        taskId: 'task-1',
        stepId: 'step-1',
        description: 'Raced amendment',
        reason: 'racing a human approval',
        workerId: ARCHITECT_ID,
      });
      reviewer.send(approveFrame('task-1', 1));
      okResult(await amending);

      const outcome = await reviewer.nextFrame(
        (frame) =>
          frame.type === 'ERROR' ||
          (frame.type === 'TASK_UPDATED' &&
            (frame.payload as Frame)?.id === 'task-1' &&
            (frame.payload as Frame)?.status === 'WORKING')
      );

      if (outcome.type === 'ERROR') {
        // The amendment won the mutex: the approval is refused against the NEW
        // revision and the task is still waiting for a human.
        expect(outcome.code).toBe(STATE_CONFLICT_CODE);
        expect(outcome.codeName).toBe('PLAN_REVISION_MISMATCH');
        expect(outcome.context).toEqual({
          taskId: 'task-1',
          expectedPlanRevision: 1,
          currentPlanRevision: 2,
        });
        expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
      } else {
        // The approval won the mutex: it approved exactly the revision it
        // rendered, and the amendment landed afterwards on the approved plan.
        expect((outcome.payload as { planApprovedAt?: string }).planApprovedAt).toEqual(
          expect.any(String)
        );
        expect(state.getTask('task-1')?.status).toBe('WORKING');
      }
      // Either way the counter advanced exactly once and never regressed.
      expect(revisionOf()).toBe(2);
    });
  });
});

// =============================================================================
// Plan-approval compare-and-swap (expectedPlanRevision) — integration tests.
//
// Everything here goes through a production path: a real http server on port 0,
// a real StateManager over a temp `.moe` folder, a real McpAdapter, a real
// MoeWebSocketServer and a genuine ws client for the wire tests. Store-level
// assertions run inside `state.runExclusive(...)`, which is exactly how
// WebSocketServer.withMutex reaches taskStore.approveTask — no private handler
// is ever called directly and no two direct calls are raced.
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
import { MoeError } from '../util/errors.js';
import { clearAllSpeedModeTimeouts, submitPlanTool } from '../tools/submitPlan.js';
import { getTools } from '../tools/index.js';

const STATE_CONFLICT_CODE = -32002;
const INVALID_INPUT_CODE = -32602;

describe('plan-approval revision compare-and-swap', () => {
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
   * a JSON file with no `planRevision` key at all, exactly what a pre-slice-1
   * daemon left on disk. StateManager.load uses raw loadEntities, so it survives
   * the load untouched.
   */
  function writeTask(
    overrides: Record<string, unknown> = {},
    opts: { omitPlanRevision?: boolean } = {}
  ): string {
    const id = (overrides.id as string) ?? 'task-1';
    const task: Record<string, unknown> = {
      id,
      epicId: 'epic-1',
      title: 'Test Task',
      description: '',
      definitionOfDone: ['Done'],
      taskRails: [],
      implementationPlan: [{ stepId: 'step-1', description: 'Step 1', status: 'PENDING' }],
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
    return path.join(moePath, 'tasks', `${id}.json`);
  }

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

  function connectAndCollect(endpoint = '/ws') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    openClients.push(ws);
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
      if (messages.length > 0) return Promise.resolve(messages.shift()!);
      return new Promise<string>((resolve, reject) => {
        waiting = resolve;
        setTimeout(() => {
          waiting = null;
          reject(new Error('Timeout waiting for ws frame'));
        }, timeoutMs);
      });
    }

    /** Pull frames until one of `type` arrives — broadcasts interleave with replies. */
    async function nextOfType(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for ${type}`);
        const parsed = JSON.parse(await nextMessage(remaining)) as Record<string, unknown>;
        if (parsed.type === type) return parsed;
      }
    }

    return { ws, ready, nextMessage, nextOfType };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() >= deadline) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Run an approval exactly the way production does: under the state mutex. */
  function approve(taskId: string, ...token: unknown[]) {
    return state.runExclusive(() =>
      (state.approveTask as (id: string, expected?: unknown) => Promise<unknown>)(
        taskId,
        ...(token as [unknown])
      )
    );
  }

  async function expectRefusal(
    taskId: string,
    token: unknown,
    expected: { code: number; codeName: string }
  ): Promise<MoeError> {
    let caught: unknown;
    try {
      await approve(taskId, token);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MoeError);
    const err = caught as MoeError;
    expect(err.code).toBe(expected.code);
    expect(err.codeName).toBe(expected.codeName);
    return err;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plan-approval-'));
    moePath = path.join(testDir, '.moe');
    httpServer = null;
    wsServer = null;
    openClients = [];
  });

  afterEach(async () => {
    clearAllSpeedModeTimeouts();
    for (const client of openClients) {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close();
      }
    }
    if (wsServer && !wsServer.closed) await wsServer.close();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // (A)(B)(C) accepted tokens
  // ---------------------------------------------------------------------------

  describe('accepted approvals', () => {
    it('approves when the supplied revision matches the stored one', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 4 });
      await start();

      const updated = (await approve('task-1', 4)) as { status: string; planApprovedAt?: string; planRevision?: number };

      expect(updated.status).toBe('WORKING');
      expect(typeof updated.planApprovedAt).toBe('string');
      expect(updated.planRevision).toBe(4);
      await state.flushActivityLog();
      const events = state.getActivityLog(200).filter((e) => e.taskId === 'task-1');
      expect(events.some((e) => e.event === 'PLAN_APPROVED')).toBe(true);
    });

    it('approves with no token at all (legacy caller)', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 7 });
      await start();

      const updated = (await approve('task-1')) as { status: string; planRevision?: number };

      expect(updated.status).toBe('WORKING');
      expect(updated.planRevision).toBe(7);
    });

    it('accepts an explicit 0 for a legacy row that has no stored revision', async () => {
      setupMoeFolder();
      createEpic();
      const file = writeTask({}, { omitPlanRevision: true });
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).planRevision).toBeUndefined();
      await start();
      expect(state.getTask('task-1')?.planRevision).toBeUndefined();

      const updated = (await approve('task-1', 0)) as { status: string };

      expect(updated.status).toBe('WORKING');
    });
  });

  // ---------------------------------------------------------------------------
  // (D) mismatch refusals
  // ---------------------------------------------------------------------------

  describe('revision mismatch', () => {
    it('refuses a stale (N-1) token with STATE_CONFLICT / PLAN_REVISION_MISMATCH', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 5 });
      await start();

      const err = await expectRefusal('task-1', 4, {
        code: STATE_CONFLICT_CODE,
        codeName: 'PLAN_REVISION_MISMATCH',
      });

      expect(err.context).toMatchObject({
        taskId: 'task-1',
        expectedPlanRevision: 4,
        currentPlanRevision: 5,
      });
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
    });

    it('refuses a NEWER (N+1) token too — any non-equal revision is stale-or-forged', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 5 });
      await start();

      const err = await expectRefusal('task-1', 6, {
        code: STATE_CONFLICT_CODE,
        codeName: 'PLAN_REVISION_MISMATCH',
      });

      expect(err.context).toMatchObject({ expectedPlanRevision: 6, currentPlanRevision: 5 });
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
    });

    it('refuses an explicit 0 against a non-zero stored revision', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 2 });
      await start();

      await expectRefusal('task-1', 0, {
        code: STATE_CONFLICT_CODE,
        codeName: 'PLAN_REVISION_MISMATCH',
      });
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
    });
  });

  // ---------------------------------------------------------------------------
  // (E) malformed tokens
  // ---------------------------------------------------------------------------

  describe('malformed tokens', () => {
    const MALFORMED: [string, unknown][] = [
      ['null', null],
      ['numeric string', '3'],
      ['boolean true', true],
      ['fractional', 3.5],
      ['negative', -1],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ];

    for (const [label, value] of MALFORMED) {
      it(`refuses ${label} with INVALID_INPUT instead of coercing or falling back to legacy`, async () => {
        setupMoeFolder();
        createEpic();
        writeTask({ planRevision: 3 });
        await start();

        await expectRefusal('task-1', value, {
          code: INVALID_INPUT_CODE,
          codeName: 'INVALID_INPUT',
        });

        // Never a silent legacy approval.
        expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
        expect(state.getTask('task-1')?.planApprovedAt).toBeUndefined();
      });
    }
  });

  // ---------------------------------------------------------------------------
  // (F) a refusal changes nothing
  // ---------------------------------------------------------------------------

  describe('refusals leave the task untouched', () => {
    it('does not write bytes, mutate the cache, publish, or log activity', async () => {
      setupMoeFolder();
      createEpic();
      const file = writeTask({ planRevision: 9, assignedWorkerId: 'architect-1' });
      await start();

      await state.flushActivityLog();
      const activityBefore = state.getActivityLog(500).length;
      const bytesBefore = fs.readFileSync(file, 'utf-8');
      const cachedBefore = { ...state.getTask('task-1')! };

      const published: string[] = [];
      const unsubscribe = state.subscribe((event) => published.push(event.type));

      await expectRefusal('task-1', 8, {
        code: STATE_CONFLICT_CODE,
        codeName: 'PLAN_REVISION_MISMATCH',
      });
      await expectRefusal('task-1', 'nope', {
        code: INVALID_INPUT_CODE,
        codeName: 'INVALID_INPUT',
      });

      unsubscribe();
      await state.flushActivityLog();

      expect(fs.readFileSync(file, 'utf-8')).toBe(bytesBefore);
      const cachedAfter = state.getTask('task-1')!;
      expect(cachedAfter.status).toBe('AWAITING_APPROVAL');
      expect(cachedAfter.updatedAt).toBe(cachedBefore.updatedAt);
      expect(cachedAfter.planApprovedAt).toBeUndefined();
      expect(cachedAfter.assignedWorkerId).toBe('architect-1');
      expect(cachedAfter.planRevision).toBe(9);
      expect(published).toEqual([]);
      expect(state.getActivityLog(500).length).toBe(activityBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // (G) a refusal must not cancel a pending SPEED timer
  // ---------------------------------------------------------------------------

  describe('pending SPEED auto-approval', () => {
    it('survives a refused approval — cancelSpeedModeTimeout never runs', async () => {
      setupMoeFolder({ approvalMode: 'SPEED', speedModeDelayMs: 400 });
      createEpic();
      writeTask({ status: 'PLANNING', planRevision: 0 });
      await start();

      // Arm the real timer through the real submit_plan tool.
      await submitPlanTool(state).handler({ taskId: 'task-1', steps: [{ description: 'Step 1' }] }, state);
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
      const armedRevision = state.getTask('task-1')!.planRevision;
      expect(armedRevision).toBe(1);

      await expectRefusal('task-1', 0, {
        code: STATE_CONFLICT_CODE,
        codeName: 'PLAN_REVISION_MISMATCH',
      });
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');

      await waitFor(() => state.getTask('task-1')?.status === 'WORKING');

      await state.flushActivityLog();
      const events = state.getActivityLog(500).filter((e) => e.taskId === 'task-1');
      expect(events.some((e) => e.event === 'PLAN_AUTO_APPROVED')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // (H) both WebSocket routes end to end
  // ---------------------------------------------------------------------------

  describe('APPROVE_TASK over /ws', () => {
    it('approves with a matching token', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 2 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: 'task-1', expectedPlanRevision: 2 } }));

      const frame = await client.nextOfType('TASK_UPDATED');
      expect((frame.payload as { status: string }).status).toBe('WORKING');
      expect(state.getTask('task-1')?.status).toBe('WORKING');
    });

    it('approves when the key is omitted (legacy wire opt-out)', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 2 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: 'task-1' } }));

      const frame = await client.nextOfType('TASK_UPDATED');
      expect((frame.payload as { status: string }).status).toBe('WORKING');
    });

    it('refuses a stale token with a machine-readable ERROR frame', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 2 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: 'task-1', expectedPlanRevision: 1 } }));

      const frame = await client.nextOfType('ERROR');
      expect(typeof frame.message).toBe('string');
      expect(frame.operation).toBe('APPROVE_TASK');
      expect(frame.code).toBe(STATE_CONFLICT_CODE);
      expect(frame.codeName).toBe('PLAN_REVISION_MISMATCH');
      expect(frame.context).toMatchObject({
        taskId: 'task-1',
        expectedPlanRevision: 1,
        currentPlanRevision: 2,
      });
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
    });

    it('refuses an explicit JSON null token with INVALID_INPUT and leaks no error context', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 2 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: 'task-1', expectedPlanRevision: null } }));

      const frame = await client.nextOfType('ERROR');
      expect(frame.code).toBe(INVALID_INPUT_CODE);
      expect(frame.codeName).toBe('INVALID_INPUT');
      // invalidInput() carries { field, reason } — neither may cross the wire.
      expect(Object.keys(frame.context as Record<string, unknown>).sort()).toEqual(['taskId']);
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
    });

    it('keeps unrelated errors backwards compatible — no code, no codeName, no extra context', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ status: 'WORKING', planRevision: 2 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: 'task-1', expectedPlanRevision: 2 } }));

      const frame = await client.nextOfType('ERROR');
      expect(frame.message).toContain('Cannot approve task in WORKING status');
      expect(frame.operation).toBe('APPROVE_TASK');
      expect(frame.code).toBeUndefined();
      expect(frame.codeName).toBeUndefined();
      expect(Object.keys(frame.context as Record<string, unknown>).sort()).toEqual(['taskId']);
    });
  });

  describe('UPDATE_TASK AWAITING_APPROVAL -> WORKING route over /ws', () => {
    it('approves with a matching token beside taskId/updates', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 3 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' }, expectedPlanRevision: 3 },
      }));

      const frame = await client.nextOfType('TASK_UPDATED');
      const payload = frame.payload as { status: string; planApprovedAt?: string };
      expect(payload.status).toBe('WORKING');
      expect(typeof payload.planApprovedAt).toBe('string');
    });

    it('approves when the key is omitted (legacy board drag)', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 3 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' } },
      }));

      const frame = await client.nextOfType('TASK_UPDATED');
      expect((frame.payload as { status: string }).status).toBe('WORKING');
    });

    it('refuses a stale token and keeps the task AWAITING_APPROVAL', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 3 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' }, expectedPlanRevision: 2 },
      }));

      const frame = await client.nextOfType('ERROR');
      expect(frame.operation).toBe('UPDATE_TASK');
      expect(frame.code).toBe(STATE_CONFLICT_CODE);
      expect(frame.codeName).toBe('PLAN_REVISION_MISMATCH');
      expect((frame.context as { taskId: string }).taskId).toBe('task-1');
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
      expect(state.getTask('task-1')?.planApprovedAt).toBeUndefined();
    });

    it('refuses an explicit null token with INVALID_INPUT', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 3 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING' }, expectedPlanRevision: null },
      }));

      const frame = await client.nextOfType('ERROR');
      expect(frame.code).toBe(INVALID_INPUT_CODE);
      expect(frame.codeName).toBe('INVALID_INPUT');
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
    });
  });

  // ---------------------------------------------------------------------------
  // (I) forgery — the token is command metadata, never a task field
  // ---------------------------------------------------------------------------

  describe('forged revision fields inside updates', () => {
    it('never persists planRevision or expectedPlanRevision supplied by a client', async () => {
      setupMoeFolder();
      createEpic();
      const file = writeTask({ status: 'BACKLOG', planRevision: 1 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          updates: { title: 'Renamed', planRevision: 999, expectedPlanRevision: 999 },
        },
      }));

      const frame = await client.nextOfType('TASK_UPDATED');
      expect((frame.payload as { title: string }).title).toBe('Renamed');
      expect((frame.payload as { planRevision?: number }).planRevision).toBe(1);
      const persisted = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(persisted.planRevision).toBe(1);
      expect(persisted.expectedPlanRevision).toBeUndefined();
      expect(state.getTask('task-1')?.planRevision).toBe(1);
      expect((state.getTask('task-1') as Record<string, unknown>).expectedPlanRevision).toBeUndefined();
    });

    it('does not let a correct token hidden in updates rescue a stale top-level token', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 4 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: {
          taskId: 'task-1',
          updates: { status: 'WORKING', expectedPlanRevision: 4 },
          expectedPlanRevision: 3,
        },
      }));

      const frame = await client.nextOfType('ERROR');
      expect(frame.codeName).toBe('PLAN_REVISION_MISMATCH');
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
    });

    it('does not use a stale token hidden in updates when the top-level key is omitted', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ planRevision: 4 });
      await start();
      const client = connectAndCollect();
      await client.ready;

      client.ws.send(JSON.stringify({
        type: 'UPDATE_TASK',
        payload: { taskId: 'task-1', updates: { status: 'WORKING', expectedPlanRevision: 1 } },
      }));

      const frame = await client.nextOfType('TASK_UPDATED');
      expect((frame.payload as { status: string }).status).toBe('WORKING');
    });
  });

  // ---------------------------------------------------------------------------
  // (J) a serialized newer-submit-before-older-approval race
  // ---------------------------------------------------------------------------

  describe('resubmit-then-approve race', () => {
    it('rejects the revision the client rendered and accepts the current one', async () => {
      setupMoeFolder();
      createEpic();
      writeTask({ status: 'PLANNING', planRevision: 0 });
      await start();
      const tool = submitPlanTool(state);

      await tool.handler({ taskId: 'task-1', steps: [{ description: 'First plan' }] }, state);
      const rendered = state.getTask('task-1')!.planRevision;
      expect(rendered).toBe(1);

      // Architect bounces it back and resubmits — the client still shows revision 1.
      await state.runExclusive(() => state.rejectTask('task-1', 'needs work'));
      await tool.handler({ taskId: 'task-1', steps: [{ description: 'Second plan' }] }, state);
      const current = state.getTask('task-1')!.planRevision;
      expect(current).toBe(2);

      const client = connectAndCollect();
      await client.ready;
      client.ws.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: 'task-1', expectedPlanRevision: rendered } }));
      const refused = await client.nextOfType('ERROR');
      expect(refused.codeName).toBe('PLAN_REVISION_MISMATCH');
      expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');

      client.ws.send(JSON.stringify({ type: 'APPROVE_TASK', payload: { taskId: 'task-1', expectedPlanRevision: current } }));
      const accepted = await client.nextOfType('TASK_UPDATED');
      expect((accepted.payload as { status: string }).status).toBe('WORKING');
    });
  });

  // ---------------------------------------------------------------------------
  // (K) registration census
  // ---------------------------------------------------------------------------

  describe('MCP tool census', () => {
    it('registers no approve_task tool — approval reaches the daemon only over /ws', async () => {
      setupMoeFolder();
      createEpic();
      writeTask();
      await start();

      const names = getTools(state).map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => name.includes('approve_task'))).toEqual([]);
    });
  });
});

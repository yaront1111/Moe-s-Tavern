// task-5158e85b: claim_next_task's post-claim recompute and release_task's
// handoff capture spawn `git status` (util/diskState.ts, killed at 3 s). Both
// tools are `blocking`, so MCP dispatch (McpAdapter) does not wrap them in the
// global state mutex: the git call runs with the mutex free and other tools keep
// answering, while each tool's own writes still run inside its state.runExclusive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAdapter, type JsonRpcResponse } from '../server/McpAdapter.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { computeDiskStateSignature } from '../util/diskState.js';

vi.mock('../util/diskState.js', () => ({ computeDiskStateSignature: vi.fn() }));
const mockedSignature = vi.mocked(computeDiskStateSignature);

const STORED = 'v1:9f2c0a1b3d4e5f60718293a4b5c6d7e8f9012345:3:0a1b2c3d4e5f';
const MOVED = 'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1:ffeeddccbbaa';
// With the mutex free the bystander answers in milliseconds. Under the bug it
// queues behind the parked capture, so the test opens the gate after this bound
// and fails on its assertions instead of hanging.
const BYSTANDER_BOUND_MS = 2000;

describe('disk-state git call vs the fleet-wide state mutex (MCP dispatch)', () => {
  const h = new ToolTestHarness();
  let adapter: McpAdapter;
  let nextId = 1;
  let heldDuringCapture: boolean[];
  let heldDuringWrites: boolean[];
  let events: string[];
  let captureEntered: Promise<void>;
  let finishCapture: () => void;

  beforeEach(() => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    heldDuringCapture = [];
    heldDuringWrites = [];
    events = [];
    let entered!: () => void;
    captureEntered = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finishCapture = resolve; });
    mockedSignature.mockReset();
    mockedSignature.mockImplementation(async () => {
      heldDuringCapture.push(h.state.mutex.isHeld());
      entered();
      await gate;
      events.push('capture-end');
      return MOVED;
    });
  });

  afterEach(() => {
    finishCapture(); // never leave a capture parked on the gate
    vi.restoreAllMocks();
    h.cleanup();
  });

  /** Load state, record whether each task/worker write runs under the mutex, then build the adapter. */
  async function start(): Promise<void> {
    await h.state.load();
    const realUpdateTask = h.state.updateTask.bind(h.state);
    vi.spyOn(h.state, 'updateTask').mockImplementation(async (...args) => {
      heldDuringWrites.push(h.state.mutex.isHeld());
      return realUpdateTask(...args);
    });
    const realUpdateWorker = h.state.updateWorker.bind(h.state);
    vi.spyOn(h.state, 'updateWorker').mockImplementation(async (...args) => {
      heldDuringWrites.push(h.state.mutex.isHeld());
      return realUpdateWorker(...args);
    });
    adapter = new McpAdapter(h.state);
  }

  function call(name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    return adapter.handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }) as Promise<JsonRpcResponse>;
  }

  function payload(response: JsonRpcResponse): Record<string, unknown> {
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  /** Once the capture is parked, send moe.list_tasks and report whether it answered within the bound. */
  async function bystanderDuringCapture(): Promise<{ winner: string; listed: Promise<JsonRpcResponse> }> {
    await captureEntered;
    const listed = call('moe.list_tasks', {}).then((response) => { events.push('bystander'); return response; });
    const winner = await Promise.race([
      listed.then(() => 'bystander'),
      new Promise<string>((resolve) => setTimeout(() => resolve('bound'), BYSTANDER_BOUND_MS)),
    ]);
    return { winner, listed };
  }

  it('(d1) release_task with a handoffNote captures disk state with the mutex free while a bystander tool answers', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-a' });
    h.createWorker({ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING' });
    await start();

    const release = call('moe.release_task', {
      taskId: 'task-1', workerId: 'worker-a', handoffNote: { whatIsDone: 'half', whatRemains: 'the rest' },
    });
    const { winner, listed } = await bystanderDuringCapture();
    finishCapture();
    const [released, bystander] = await Promise.all([release, listed]);

    expect(heldDuringCapture).toEqual([false]);
    expect(winner).toBe('bystander');
    expect(events).toEqual(['bystander', 'capture-end']);
    payload(bystander);
    expect(payload(released)).toMatchObject({ success: true, diskStateCaptured: true });
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(h.state.getTask('task-1')!.priorHandoffs![0].diskState).toBe(MOVED);
    expect(heldDuringWrites.length).toBeGreaterThan(0);
    expect(heldDuringWrites.every(Boolean)).toBe(true);
  });

  it('(d2) claim_next_task recomputes a stored handoff diskState with the mutex free while a bystander tool answers', async () => {
    h.createTask({
      id: 'task-2', status: 'WORKING', assignedWorkerId: null,
      priorHandoffs: [{ whatIsDone: 'x', whatRemains: 'y', releasedBy: 'worker-gone', releasedAt: new Date().toISOString(), diskState: STORED }],
    });
    h.createWorker({ id: 'worker-b' });
    await start();

    const claim = call('moe.claim_next_task', { workerId: 'worker-b', statuses: ['WORKING'] });
    const { winner, listed } = await bystanderDuringCapture();
    finishCapture();
    const [claimed, bystander] = await Promise.all([claim, listed]);

    expect(heldDuringCapture).toEqual([false]);
    expect(winner).toBe('bystander');
    expect(events).toEqual(['bystander', 'capture-end']);
    payload(bystander);
    expect(payload(claimed)).toMatchObject({ hasNext: true, staleHandoffDiskState: true });
    expect(h.state.getTask('task-2')!.assignedWorkerId).toBe('worker-b');
    expect(heldDuringWrites.length).toBeGreaterThan(0);
    expect(heldDuringWrites.every(Boolean)).toBe(true);
  });
});

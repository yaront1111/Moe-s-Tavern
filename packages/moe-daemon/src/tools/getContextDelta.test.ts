import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { getContextTool } from './getContext.js';
import { reattachAttemptTool } from './reattachAttempt.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { StateManager } from '../state/StateManager.js';
import { getAttempt, openAttempt, reconcileRunningAttempts, setAttemptPhase } from '../state/attemptStore.js';
import { applyDelta, diffPackets, type ContextDelta } from '../context/contextDelta.js';
import type { ExecutionAttempt } from '../types/schema.js';

// Pass-through: every case diffs for real unless a test overrides one call.
vi.mock('../context/contextDelta.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../context/contextDelta.js')>();
  return { ...actual, diffPackets: vi.fn(actual.diffPackets) };
});

// CQ-C06: get_context serves a delta only against the exact base this receiving
// session acknowledged, in this daemon process, on this attempt incarnation.
const SESSION = 'worker-r@2026-10-29T10:00:00Z';
const STARTED = '4242@2026-10-29T09:59:00.000Z';
const HOST = 'vm-1';
const NOW = Date.parse('2026-10-29T10:00:00.000Z');

type ServedContext = Record<string, unknown> & { packetId: string | null; receiptId: string | null };
type Served = Record<string, unknown> & { servedContext: ServedContext; delta?: ContextDelta };

const sha = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
const body = ({ servedContext: _served, ...packet }: Served) => packet;
const full = (reason: string) => ({ served: 'full', reason });

describe('moe.get_context acknowledged deltas', () => {
  const h = new ToolTestHarness();
  let attempt: ExecutionAttempt;
  const extraStates: StateManager[] = [];

  beforeEach(async () => {
    // Date only: every read stamps worker.lastActivityAt, so a frozen clock keeps equal state equal.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    vi.stubEnv('MOE_WORKER_ID', '');
    vi.stubEnv('MOE_TASK_ID', '');
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createWorker({ id: 'worker-r', currentTaskId: 'task-1', status: 'CODING' });
    h.createTask({
      status: 'WORKING', assignedWorkerId: 'worker-r', planRevision: 3, approvedPlanRevision: 3,
      priorBlockedReason: 'waiting on C05',
    });
    await h.state.load();
    attempt = await openAttempt(h.state, {
      taskId: 'task-1', workerId: 'worker-r', runnerId: 'runner-r', workspace: h.testDir, processStartedAt: STARTED, host: HOST,
    });
  });

  afterEach(() => {
    for (const state of extraStates.splice(0)) state.clearEmitter();
    h.state.clearEmitter();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    h.cleanup();
  });

  const read = (args: Record<string, unknown> = {}, state: StateManager = h.state) => getContextTool(state).handler(
    { taskId: 'task-1', workerId: 'worker-r', sessionId: SESSION, ...args }, state) as Promise<Served>;
  const acknowledge = async (contextEpoch = 0) => (await read({ contextEpoch })).servedContext.packetId!;
  const reattach = (state: StateManager, id = attempt.id) => reattachAttemptTool(state).handler({
    taskId: 'task-1', workerId: 'worker-r', runnerId: 'runner-r', attemptId: id, generation: 1, processStartedAt: STARTED, host: HOST,
  }, state);

  it('D1: serves an explicit-removal delta that reconstructs the receipted full packet', async () => {
    const first = await read({ contextEpoch: 0 });
    expect(first.servedContext.contextDelta).toStrictEqual(full('no-base'));
    expect(body(first).task).toMatchObject({ priorBlockedReason: 'waiting on C05' });
    await h.state.updateTask('task-1', { priorBlockedReason: undefined, reopenReason: 'second round' });

    const second = await read({ basePacketId: first.servedContext.packetId, contextEpoch: 0 });
    expect(Object.keys(second).sort()).toEqual(['delta', 'servedContext']);
    expect(second.servedContext).toStrictEqual({
      taskId: 'task-1', planRevision: 3, approvedPlanRevision: 3, attemptId: attempt.id, generation: 1,
      receiptStatus: 'recorded', receiptId: expect.stringMatching(/^ctxreceipt-[0-9a-f]{32}$/),
      packetId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), contextDelta: { served: 'delta' },
    });
    expect(second.delta).toStrictEqual({
      basePacketId: first.servedContext.packetId, packetId: second.servedContext.packetId,
      changed: [{ pointer: '/task/reopenReason', value: 'second round' }], removed: ['/task/priorBlockedReason'],
    });
    expect(getAttempt(h.state, attempt.id)?.contextReceipt).toMatchObject({
      id: second.servedContext.receiptId, packetId: second.servedContext.packetId, sessionId: SESSION,
    });

    const after = await read();
    expect(after.servedContext.packetId).toBe(second.servedContext.packetId);
    expect(sha(body(after))).toBe(second.servedContext.packetId);
    expect(applyDelta(body(first), second.delta!)).toStrictEqual(body(after));
  });

  it('D1: an unchanged packet is an empty delta', async () => {
    const base = await acknowledge();
    const again = await read({ basePacketId: base, contextEpoch: 0 });
    expect(again.delta).toStrictEqual({ basePacketId: base, packetId: base, changed: [], removed: [] });
  });

  it('D2: a wrong or older base gets the full packet (base-mismatch)', async () => {
    const older = await acknowledge();
    await h.state.updateTask('task-1', { reopenReason: 'moved on' });
    expect((await read({ basePacketId: older, contextEpoch: 0 })).delta).toBeDefined();
    const stale = await read({ basePacketId: older, contextEpoch: 0 });
    expect(stale.servedContext.contextDelta).toStrictEqual(full('base-mismatch'));
    expect(stale).not.toHaveProperty('delta');
    expect(body(stale).task).toMatchObject({ id: 'task-1', reopenReason: 'moved on' });
    const forged = await read({ basePacketId: `sha256:${'b'.repeat(64)}`, contextEpoch: 0 });
    expect(forged.servedContext.contextDelta).toStrictEqual(full('base-mismatch'));
  });

  it('D3: an epoch without a base gets the full packet (no-base); a base on an empty store, base-unavailable', async () => {
    const fresh = await read({ basePacketId: `sha256:${'c'.repeat(64)}`, contextEpoch: 0 });
    expect(fresh.servedContext.contextDelta).toStrictEqual(full('base-unavailable'));
    await acknowledge();
    expect((await read({ contextEpoch: 0 })).servedContext.contextDelta).toStrictEqual(full('no-base'));
  });

  it('D4: a daemon restart serves a full packet although the persisted receipt still names the base', async () => {
    const base = await acknowledge();
    const restarted = new StateManager({ projectPath: h.testDir });
    extraStates.push(restarted);
    await restarted.load();
    await restarted.runExclusive(() => reconcileRunningAttempts(restarted));
    await reattach(restarted);
    expect(getAttempt(restarted, attempt.id)?.contextReceipt?.packetId).toBe(base);
    const served = await read({ basePacketId: base, contextEpoch: 0 }, restarted);
    expect(served.servedContext).toMatchObject({ receiptStatus: 'recorded', contextDelta: full('base-unavailable') });
    expect(body(served).task).toMatchObject({ id: 'task-1' });
  });

  it('D5: a compaction epoch change, or a missing epoch, gets the full packet and leaves no base behind', async () => {
    const base = await acknowledge(0);
    const compacted = await read({ basePacketId: base, contextEpoch: 1 });
    expect(compacted.servedContext.contextDelta).toStrictEqual(full('epoch-changed'));
    const unknown = await read({ basePacketId: compacted.servedContext.packetId });
    expect(unknown.servedContext.contextDelta).toStrictEqual(full('epoch-missing'));
    const later = await read({ basePacketId: unknown.servedContext.packetId, contextEpoch: 1 });
    expect(later.servedContext.contextDelta).toStrictEqual(full('base-unavailable'));
  });

  it('D6: another session gets the full packet (session-mismatch)', async () => {
    const base = await acknowledge();
    const other = await read({ sessionId: 'worker-r@2026-10-29T11:00:00Z', basePacketId: base, contextEpoch: 0 });
    expect(other.servedContext.contextDelta).toStrictEqual(full('session-mismatch'));
  });

  it('D6: a re-claim or VM replacement opens a new attempt generation (attempt-mismatch)', async () => {
    const base = await acknowledge();
    await setAttemptPhase(h.state, attempt.id, 'closed');
    const next = await openAttempt(h.state, {
      taskId: 'task-1', workerId: 'worker-r', runnerId: 'runner-r', workspace: h.testDir, processStartedAt: 'other@vm', host: 'vm-2',
    });
    const served = await read({ basePacketId: base, contextEpoch: 0 });
    expect(served.servedContext).toMatchObject({ attemptId: next.id, generation: 2, contextDelta: full('attempt-mismatch') });
  });

  it('D6: a different recorded runner gets the full packet (runner-changed)', async () => {
    const base = await acknowledge();
    h.state.attempts.set(attempt.id, { ...h.state.attempts.get(attempt.id)!, host: 'vm-2' });
    expect((await read({ basePacketId: base, contextEpoch: 0 })).servedContext.contextDelta).toStrictEqual(full('runner-changed'));
  });

  it('D7: an in-process reconcile and reattach is never a base acknowledgement (phase-changed)', async () => {
    const base = await acknowledge();
    vi.setSystemTime(NOW + 60_000);
    await setAttemptPhase(h.state, attempt.id, 'reconciling');
    await reattach(h.state);
    expect(getAttempt(h.state, attempt.id)).toMatchObject({ phase: 'running', contextReceipt: { packetId: base } });
    const served = await read({ basePacketId: base, contextEpoch: 0 });
    expect(served.servedContext.contextDelta).toStrictEqual(full('phase-changed'));
    expect(served).not.toHaveProperty('delta');
  });

  it('D8: a read presenting neither field is the legacy packet, even over a stored base', async () => {
    const base = await acknowledge();
    const legacy = await read();
    expect(legacy).not.toHaveProperty('delta');
    expect(legacy.servedContext).toStrictEqual({
      taskId: 'task-1', planRevision: 3, approvedPlanRevision: 3, attemptId: attempt.id, generation: 1,
      receiptStatus: 'recorded', receiptId: expect.stringMatching(/^ctxreceipt-/), packetId: sha(body(legacy)),
    });
    expect(body(legacy)).not.toHaveProperty('contextDelta');
    // A legacy read leaves the stored base alone: only a read presenting a field writes or clears it.
    expect((await read({ basePacketId: base, contextEpoch: 0 })).servedContext.contextDelta).toStrictEqual({ served: 'delta' });
  });

  it('a diff failure serves the full packet (diff-failed), and that packet becomes the next base', async () => {
    const base = await acknowledge();
    await h.state.updateTask('task-1', { reopenReason: 'third round' });
    vi.mocked(diffPackets).mockImplementationOnce(() => { throw new RangeError('forced diff failure'); });
    const failed = await read({ basePacketId: base, contextEpoch: 0 });
    expect(failed.servedContext.contextDelta).toStrictEqual(full('diff-failed'));
    expect(failed).not.toHaveProperty('delta');
    expect(body(failed).task).toMatchObject({ reopenReason: 'third round' });
    expect(sha(body(failed))).toBe(failed.servedContext.packetId);
    const next = await read({ basePacketId: failed.servedContext.packetId, contextEpoch: 0 });
    expect(next.delta).toStrictEqual({
      basePacketId: failed.servedContext.packetId, packetId: failed.servedContext.packetId, changed: [], removed: [],
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no session', { sessionId: undefined }, 'no-session'],
    ['a non-owner', { workerId: 'worker-x' }, 'not-attempt-owner'],
  ])('D9: an unrecorded read (%s) presenting a base gets the full packet and stores nothing', async (_name, args, reason) => {
    const unrecorded = await read({ ...args, contextEpoch: 0 });
    expect(unrecorded.servedContext).toMatchObject({ receiptStatus: reason, packetId: null, contextDelta: full(reason) });
    const presented = await read({ ...args, basePacketId: sha(body(unrecorded)), contextEpoch: 0 });
    expect(presented.servedContext.contextDelta).toStrictEqual(full(reason));
    const owner = await read({ basePacketId: sha(body(unrecorded)), contextEpoch: 0 });
    expect(owner.servedContext.contextDelta).toStrictEqual(full('base-unavailable'));
  });

  it.each<[string, Record<string, unknown>]>([
    ['a short basePacketId', { basePacketId: 'sha256:abc' }],
    ['an uppercase basePacketId', { basePacketId: `sha256:${'A'.repeat(64)}` }],
    ['a numeric basePacketId', { basePacketId: 7 }],
    ['a negative contextEpoch', { contextEpoch: -1 }],
    ['a fractional contextEpoch', { contextEpoch: 1.5 }],
    ['a string contextEpoch', { contextEpoch: '0' }],
  ])('refuses %s before any write', async (_name, args) => {
    const write = vi.spyOn(h.state, 'writeEntity');
    await expect(read(args)).rejects.toMatchObject({ codeName: 'INVALID_INPUT' });
    expect(write).not.toHaveBeenCalled();
    expect(h.state.getTask('task-1')?.contextFetchedBy).toBeUndefined();
  });
});

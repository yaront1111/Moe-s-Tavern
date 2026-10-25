import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { getContextTool } from './getContext.js';
import { ToolTestHarness } from './toolTestHarness.js';
import {
  currentAttempt, getAttempt, openAttempt, readContextReceipt, recordAttemptPresence, recordContextReceipt, setAttemptPhase,
} from '../state/attemptStore.js';
import type { ExecutionAttempt, ExecutionPolicySnapshot, ServedContextReceipt } from '../types/schema.js';

const SESSION = 'worker-r@2026-10-25T11:00:00Z';
const PACKET = `sha256:${'a'.repeat(64)}`;

describe('served-context receipts', () => {
  const h = new ToolTestHarness();
  let attempt: ExecutionAttempt;

  beforeEach(async () => {
    vi.stubEnv('MOE_WORKER_ID', '');
    vi.stubEnv('MOE_TASK_ID', '');
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createWorker({ id: 'worker-r', currentTaskId: 'task-1', status: 'CODING' });
    h.createTask({ status: 'WORKING', assignedWorkerId: 'worker-r', planRevision: 3, approvedPlanRevision: 3 });
    await h.state.load();
    attempt = await openAttempt(h.state, { taskId: 'task-1', workerId: 'worker-r', runnerId: 'runner-r', workspace: h.testDir });
  });

  afterEach(() => { h.state.clearEmitter(); vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup(); });

  const fileBytes = () => fs.readFileSync(path.join(h.moePath, 'attempts', `${attempt.id}.json`), 'utf8');
  const record = (over: Record<string, unknown> = {}) => recordContextReceipt(h.state, {
    attemptId: attempt.id, workerId: 'worker-r', sessionId: SESSION, packetId: PACKET,
    planRevision: 3, approvedPlanRevision: 3, view: 'default', ...over,
  } as Parameters<typeof recordContextReceipt>[1]);
  const receipt = (over: Record<string, unknown> = {}): ServedContextReceipt => ({
    id: 'ctxreceipt-1', packetId: PACKET, taskId: 'task-1', attemptId: 'attempt-1', generation: 1,
    workerId: 'worker-r', sessionId: SESSION, planRevision: 3, approvedPlanRevision: 3, view: 'default',
    servedAt: '2026-10-25T11:00:00.000Z', ...over,
  }) as ServedContextReceipt;

  describe('attemptStore', () => {
    it.each([
      ['an unknown attempt', null, { attemptId: 'attempt-missing' }, 'ATTEMPT_NOT_FOUND'],
      ['a closed attempt', 'closed', {}, 'ATTEMPT_NOT_RUNNING'],
      ['a finalizing attempt', 'finalizing', {}, 'ATTEMPT_NOT_RUNNING'],
      ['another worker', null, { workerId: 'worker-x' }, 'NOT_ALLOWED'],
      ['a short packetId', null, { packetId: 'sha256:abc' }, 'INVALID_INPUT'],
      ['planRevision -1', null, { planRevision: -1 }, 'INVALID_INPUT'],
      ['planRevision 1.5', null, { planRevision: 1.5 }, 'INVALID_INPUT'],
      ['approvedPlanRevision -1', null, { approvedPlanRevision: -1 }, 'INVALID_INPUT'],
      ['view status', null, { view: 'status' }, 'INVALID_INPUT'],
    ] as const)('refuses %s before any write', async (_name, phase, over, codeName) => {
      if (phase) await setAttemptPhase(h.state, attempt.id, phase);
      const before = structuredClone(h.state.attempts.get(attempt.id));
      const bytes = fileBytes();
      const write = vi.spyOn(h.state, 'writeEntity');
      await expect(record(over)).rejects.toMatchObject({ codeName });
      expect(write).not.toHaveBeenCalled();
      expect(h.state.attempts.get(attempt.id)).toStrictEqual(before);
      expect(fileBytes()).toBe(bytes);
    });

    it('binds the stored attempt, persists before publishing and survives presence', async () => {
      const stored = await record({ view: 'full' });
      expect(stored).toStrictEqual({
        id: expect.stringMatching(/^ctxreceipt-[0-9a-f]{32}$/), packetId: PACKET, taskId: 'task-1',
        attemptId: attempt.id, generation: 1, workerId: 'worker-r', sessionId: SESSION,
        planRevision: 3, approvedPlanRevision: 3, view: 'full', servedAt: expect.any(String),
      });
      expect(JSON.parse(fileBytes()).contextReceipt).toStrictEqual(stored);
      const copy = getAttempt(h.state, attempt.id)!;
      copy.contextReceipt!.sessionId = 'mutated';
      expect(h.state.attempts.get(attempt.id)?.contextReceipt?.sessionId).toBe(SESSION);
      const phaseAt = h.state.attempts.get(attempt.id)?.lastPhaseAt;
      await recordAttemptPresence(h.state, attempt.id, 'progress');
      expect(getAttempt(h.state, attempt.id)).toMatchObject({ contextReceipt: stored, lastPhaseAt: phaseAt, phase: 'running' });
    });
  });

  describe('readContextReceipt', () => {
    it('passes undefined through and copies a valid receipt', () => {
      expect(readContextReceipt(undefined)).toBeUndefined();
      const valid = receipt();
      const decoded = readContextReceipt(valid);
      expect(decoded).toStrictEqual(valid);
      expect(decoded).not.toBe(valid);
      const { approvedPlanRevision: _omit, ...unapproved } = valid;
      expect(readContextReceipt(unapproved)).toStrictEqual(unapproved);
    });

    it.each([
      ['an extra key', { ...receipt(), extra: true }],
      ['a missing key', (({ sessionId: _s, ...rest }) => rest)(receipt())],
      ['a wrong-typed generation', receipt({ generation: '1' })],
      ['a null approvedPlanRevision', receipt({ approvedPlanRevision: null })],
      ['a blank workerId', receipt({ workerId: ' ' })],
      ['a multi-line sessionId', receipt({ sessionId: 'a\nb' })],
      ['a non-object', 'receipt'],
    ])('refuses %s', (_name, value) => {
      expect(() => readContextReceipt(value)).toThrow(expect.objectContaining({ codeName: 'INVALID_INPUT' }));
    });
  });

  describe('moe.get_context', () => {
    type Served = Record<string, unknown> & { servedContext?: Record<string, unknown> };
    const read = (args: Record<string, unknown> = {}) => getContextTool(h.state).handler(
      { taskId: 'task-1', workerId: 'worker-r', sessionId: SESSION, ...args }, h.state) as Promise<Served>;
    const stored = () => JSON.parse(fileBytes()).contextReceipt as ServedContextReceipt | undefined;
    const attemptWrites = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([kind]) => kind === 'attempts');
    const sha = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
    const task = () => h.state.getTask('task-1')!;

    it.each([[undefined, 'default'], ['full', 'full']] as const)('records a durable receipt for view %s', async (view, name) => {
      const { servedContext, ...packet } = await read({ view });
      expect(servedContext).toStrictEqual({
        taskId: 'task-1', planRevision: 3, approvedPlanRevision: 3, attemptId: attempt.id, generation: 1,
        receiptStatus: 'recorded', receiptId: expect.stringMatching(/^ctxreceipt-[0-9a-f]{32}$/),
        packetId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(servedContext!.packetId).toBe(sha(packet));
      const durable = stored();
      expect(durable).toStrictEqual({
        id: servedContext!.receiptId, packetId: servedContext!.packetId, taskId: 'task-1', attemptId: attempt.id,
        generation: 1, workerId: 'worker-r', sessionId: SESSION, planRevision: 3, approvedPlanRevision: 3,
        view: name, servedAt: expect.any(String),
      });
      await h.state.load();
      expect(getAttempt(h.state, attempt.id)?.contextReceipt).toStrictEqual(durable);
    });

    it('never records on a view:"status" poll', async () => {
      const bytes = fileBytes();
      const write = vi.spyOn(h.state, 'writeEntity');
      expect(await read({ view: 'status' })).not.toHaveProperty('servedContext');
      expect(fileBytes()).toBe(bytes);
      expect(attemptWrites(write)).toEqual([]);
    });

    it('replaces the receipt per session and records an advanced planRevision', async () => {
      const first = (await read()).servedContext!;
      const second = (await read({ sessionId: 'worker-r@2026-10-25T12:00:00Z' })).servedContext!;
      expect(second.receiptId).not.toBe(first.receiptId);
      expect(stored()).toMatchObject({ id: second.receiptId, sessionId: 'worker-r@2026-10-25T12:00:00Z' });
      await h.state.updateTask('task-1', { definitionOfDone: ['A changed contract'] });
      expect((await read()).servedContext).toMatchObject({ planRevision: 4, approvedPlanRevision: 3, receiptStatus: 'recorded' });
      expect(stored()).toMatchObject({ planRevision: 4, approvedPlanRevision: 3 });
    });

    it.each<[string, Record<string, unknown>, Record<string, unknown>, () => unknown]>([
      ['no session (env is never read)', { receiptStatus: 'no-session' }, { sessionId: undefined }, () => vi.stubEnv('MOE_SESSION_ID', SESSION)],
      ['no attempt', { receiptStatus: 'no-running-attempt', attemptId: null }, {}, () => h.state.attempts.clear()],
      ['a finalizing attempt', { receiptStatus: 'no-running-attempt' }, {}, () => setAttemptPhase(h.state, attempt.id, 'finalizing')],
      ['a reconciling attempt', { receiptStatus: 'no-running-attempt' }, {}, () => setAttemptPhase(h.state, attempt.id, 'reconciling')],
      ['a closed attempt', { receiptStatus: 'no-running-attempt', attemptId: null }, {}, () => setAttemptPhase(h.state, attempt.id, 'closed')],
      ['another caller', { receiptStatus: 'not-attempt-owner' }, { workerId: 'worker-x' }, () => undefined],
      ['a task assigned elsewhere', { receiptStatus: 'not-attempt-owner' }, {}, () => { task().assignedWorkerId = 'worker-y'; }],
      ['an anonymous caller', { receiptStatus: 'not-attempt-owner' }, { workerId: undefined }, () => undefined],
      ['an unreadable planRevision', { receiptStatus: 'identity-unreadable', planRevision: null }, {}, () => { task().planRevision = -1; }],
    ])('serves %s without a receipt or an attempt write', async (_name, expected, args, arrange) => {
      await arrange();
      const write = vi.spyOn(h.state, 'writeEntity');
      expect((await read(args)).servedContext).toMatchObject({ ...expected, receiptId: null, packetId: null });
      expect(attemptWrites(write)).toEqual([]);
    });

    it.each([
      { version: 2, profile: 'legacy', planRevision: 3, deliveryPolicy: 'legacy' },
      { version: 2, profile: 'verified-local', planRevision: 3, deliveryPolicy: 'local-branch' },
    ] as ExecutionPolicySnapshot[])('serves no receipt ids when the attempt write fails ($profile)', async (snapshot) => {
      h.state.attempts.set(attempt.id, { ...h.state.attempts.get(attempt.id)!, executionPolicySnapshot: snapshot });
      const bytes = fileBytes();
      const writeEntity = h.state.writeEntity.bind(h.state);
      vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
        if (kind === 'attempts') throw new Error('Injected attempt write failure');
        await writeEntity(kind, id, entity);
      });
      const served = await read();
      expect(served.task).toMatchObject({ id: 'task-1' });
      expect(served.servedContext).toMatchObject({ receiptStatus: 'record-failed', receiptId: null, packetId: null });
      expect(h.state.attempts.get(attempt.id)).not.toHaveProperty('contextReceipt');
      expect(fileBytes()).toBe(bytes);
      expect(readContextReceipt(currentAttempt(h.state, 'task-1')?.contextReceipt)).toBeUndefined();
    });

    it('serves no receipt ids when the stored attempt fails receipt validation', async () => {
      h.state.attempts.set(attempt.id, { ...h.state.attempts.get(attempt.id)!, generation: 0 });
      expect((await read()).servedContext).toMatchObject({ receiptStatus: 'record-failed', receiptId: null, packetId: null });
      expect(h.state.attempts.get(attempt.id)).not.toHaveProperty('contextReceipt');
    });

    it.each(
      [['empty', ''], ['blank', '  '], ['numeric', 7], ['null', null], ['object', {}], ['multi-line', 'a\nb'], ['256-char', 'x'.repeat(256)]]
        .flatMap(([label, sessionId]) => [undefined, 'status'].map((view) => [label, view, sessionId] as const))
    )('refuses a %s sessionId (view %s) before any write', async (_label, view, sessionId) => {
      const bytes = fileBytes();
      await expect(read({ sessionId, view })).rejects.toThrow(/sessionId/);
      expect(task().contextFetchedBy).toBeUndefined();
      expect(fileBytes()).toBe(bytes);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { deliveryProjection } from './deliveryProjection.js';
import { recordCandidate } from './candidateStore.js';
import { recordCheckRun } from './checkRunStore.js';
import { recordDeliveryReceipt } from './receiptStore.js';
import type { Candidate, CheckRun, DeliveryReceipt, ExecutionAttempt, Task } from '../types/schema.js';
import { createServer } from 'http';
import { once } from 'events';
import WebSocket from 'ws';
import { MoeWebSocketServer } from '../server/WebSocketServer.js';
import type { McpAdapter } from '../server/McpAdapter.js';

const SHA = 'Ab'.repeat(20);
const BASE = 'Cd'.repeat(20);
const candidate: Candidate = {
  id: 'candidate-1', taskId: 'task-1', attemptId: 'attempt-1', treeSha: SHA,
  baseRevision: BASE, deliveryTarget: 'refs/heads/pilot', createdAt: '2026-09-13T00:00:00Z',
};
const check: CheckRun = {
  id: 'check-1', candidateId: candidate.id, treeSha: SHA, command: ' npm.cmd test ',
  exitCode: -1, outputTail: '', runnerId: 'runner-1', source: 'runner-observed',
  createdAt: '2026-09-13T01:00:00Z',
};
const receipt: DeliveryReceipt = {
  id: 'receipt-1', candidateId: candidate.id, target: 'refs/heads/pilot',
  targetBefore: BASE, targetAfter: SHA, landedRevision: SHA, pushResult: null,
};
const attempt: ExecutionAttempt = {
  id: 'attempt-1', taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-1',
  generation: 1, workspace: 'D:/work', phase: 'finalizing',
  startedAt: '2026-09-13T00:00:00Z', lastPhaseAt: '2026-09-13T01:00:00Z',
};
const expected = {
  currentCandidate: { id: candidate.id, treeSha: SHA, shortSha: SHA.slice(0, 8), baseRevision: BASE },
  latestCheckRun: { command: check.command, exitCode: -1 },
  deliveryReceipt: { target: receipt.target, landedRevision: SHA },
  attemptPhase: 'finalizing',
};

describe('deliveryProjection', () => {
  const h = new ToolTestHarness();
  let task: Task;
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask();
    await h.state.load();
    task = h.state.tasks.get('task-1')!;
  });
  afterEach(() => { vi.restoreAllMocks(); h.state.clearEmitter(); h.cleanup(); });
  function seed(): void {
    h.state.candidates.set(candidate.id, candidate);
    h.state.checkRuns.set(check.id, check);
    h.state.receipts.set(receipt.id, receipt);
    h.state.attempts.set(attempt.id, attempt);
  }

  it('projects the current candidate, latest check, receipt and owning attempt', () => {
    seed();
    expect(deliveryProjection(h.state, task)).toEqual(expected);
  });

  it.each([7, 12, 39, 40].flatMap(length => [
    [length, 'tree', SHA.slice(0, length), BASE] as const,
    [length, 'base', SHA, BASE.slice(0, length)] as const,
    [length, 'tree and base', SHA.slice(0, length), BASE.slice(0, length)] as const,
  ]))('projects store-valid %i-character %s tokens with a closed owner', async (_, __, treeSha, baseRevision) => {
    h.state.attempts.set(attempt.id, { ...attempt, phase: 'closed' });
    await recordCandidate(h.state, { ...candidate, treeSha, baseRevision });
    await recordCheckRun(h.state, { ...check, treeSha });
    await recordDeliveryReceipt(h.state, receipt);
    expect(deliveryProjection(h.state, task)).toEqual({
      ...expected,
      currentCandidate: { id: candidate.id, treeSha, shortSha: treeSha.slice(0, 8), baseRevision },
      attemptPhase: 'closed',
    });
  });

  it.each(['123456', SHA + 'a', 'g'.repeat(7), 1234567])('omits invalid candidate token %s without coercion', value => {
    seed();
    for (const field of ['treeSha', 'baseRevision']) {
      h.state.candidates.set(candidate.id, { ...candidate, [field]: value } as Candidate);
      expect(deliveryProjection(h.state, task)).toEqual({ attemptPhase: 'finalizing' });
    }
  });

  it.each([7, 12, 39])('omits a %i-character receipt revision without losing other evidence', length => {
    seed();
    h.state.receipts.set(receipt.id, { ...receipt, landedRevision: SHA.slice(0, length) });
    const { deliveryReceipt: _, ...withoutReceipt } = expected;
    expect(deliveryProjection(h.state, task)).toEqual(withoutReceipt);
  });

  it.each([SHA.toLowerCase(), SHA.slice(0, 7)])('omits a check bound to a different SHA spelling %s', treeSha => {
    seed();
    h.state.checkRuns.set(check.id, { ...check, treeSha });
    const { latestCheckRun: _, ...withoutCheck } = expected;
    expect(deliveryProjection(h.state, task)).toEqual(withoutCheck);
  });

  it('returns undefined with no evidence and preserves byte-identical task payloads', () => {
    const before = JSON.stringify(task);
    const delivery = deliveryProjection(h.state, task);
    expect(delivery).toBeUndefined();
    const served = delivery === undefined ? task : { ...task, delivery };
    expect(JSON.stringify(served)).toBe(before);
    expect(h.state.getSnapshot().tasks[0]).toBe(task);
  });

  it('chooses the current candidate by createdAt then id, not insertion order', () => {
    seed();
    h.state.candidates.set('candidate-0', { ...candidate, id: 'candidate-0', treeSha: BASE });
    h.state.candidates.set('candidate-z', { ...candidate, id: 'candidate-z', createdAt: '2025-01-01', treeSha: BASE });
    expect(deliveryProjection(h.state, task)).toEqual(expected);
  });

  it('does not show checks or receipts from an older candidate against newer bytes', () => {
    seed();
    const newer = { ...candidate, id: 'candidate-2', treeSha: BASE };
    h.state.candidates.set(newer.id, newer);
    expect(deliveryProjection(h.state, task)).toEqual({
      currentCandidate: { id: newer.id, treeSha: BASE, shortSha: BASE.slice(0, 8), baseRevision: BASE },
      attemptPhase: 'finalizing',
    });
  });

  it('chooses the latest check by timestamp and id, with legacy undated rows first', () => {
    seed();
    h.state.checkRuns.set('check-2', { ...check, id: 'check-2', command: 'new', exitCode: 0 });
    h.state.checkRuns.set('check-z', { ...check, id: 'check-z', createdAt: undefined });
    expect(deliveryProjection(h.state, task)).toEqual({ ...expected, latestCheckRun: { command: 'new', exitCode: 0 } });
  });

  it('uses the candidate owning attempt, not a newer task attempt', () => {
    seed();
    h.state.attempts.set(attempt.id, { ...attempt, phase: 'closed' });
    h.state.attempts.set('attempt-2', { ...attempt, id: 'attempt-2', generation: 2, phase: 'running' });
    expect(deliveryProjection(h.state, task)).toEqual({ ...expected, attemptPhase: 'closed' });
  });

  it('shows a current attempt even before a candidate exists', () => {
    h.state.attempts.set(attempt.id, attempt);
    expect(deliveryProjection(h.state, task)).toEqual({ attemptPhase: 'finalizing' });
  });

  it('omits missing and wrong-task owning attempts without losing candidate evidence', () => {
    seed();
    h.state.attempts.clear();
    const { attemptPhase: _, ...withoutAttempt } = expected;
    expect(deliveryProjection(h.state, task)).toEqual(withoutAttempt);
    h.state.attempts.set(attempt.id, { ...attempt, taskId: 'task-other' });
    expect(deliveryProjection(h.state, task)).toEqual(withoutAttempt);
  });

  it('treats malformed records as absent without dropping other evidence', () => {
    seed();
    h.state.checkRuns.set(check.id, { ...check, exitCode: '0' } as unknown as CheckRun);
    h.state.receipts.set(receipt.id, { ...receipt, landedRevision: 42 } as unknown as DeliveryReceipt);
    h.state.attempts.set(attempt.id, { ...attempt, phase: 'bogus' } as unknown as ExecutionAttempt);
    expect(deliveryProjection(h.state, task)).toEqual({ currentCandidate: expected.currentCandidate });
  });

  it('does not throw on null store records or ambiguous receipts', () => {
    seed();
    h.state.receipts.set('receipt-2', { ...receipt, id: 'receipt-2' });
    const { deliveryReceipt: _, ...withoutReceipt } = expected;
    expect(deliveryProjection(h.state, task)).toEqual(withoutReceipt);
    h.state.candidates.set('corrupt', null as unknown as Candidate);
    h.state.checkRuns.set('corrupt', null as unknown as CheckRun);
    h.state.receipts.set('corrupt', null as unknown as DeliveryReceipt);
    expect(deliveryProjection(h.state, task)).toEqual({ attemptPhase: 'finalizing' });
  });

  it('does not mutate stored records or attach delivery to raw snapshots', () => {
    seed();
    const write = vi.spyOn(h.state, 'writeEntity');
    const before = JSON.stringify([task, candidate, check, receipt, attempt]);
    const result = deliveryProjection(h.state, task);
    expect(result).toEqual(expected);
    expect(JSON.stringify([task, candidate, check, receipt, attempt])).toBe(before);
    expect(h.state.getSnapshot().tasks[0]).not.toHaveProperty('delivery');
    expect(write).toHaveBeenCalledTimes(0);
  });

  it('prioritizes a later timestamp over lexical candidate and check ids', () => {
    seed();
    const newer = { ...candidate, id: 'candidate-0', createdAt: '2026-09-14T00:00:00Z' };
    h.state.candidates.set(newer.id, newer);
    h.state.checkRuns.set('check-9', { ...check, id: 'check-9', candidateId: newer.id });
    h.state.checkRuns.set('check-0', { ...check, id: 'check-0', candidateId: newer.id, createdAt: '2026-09-14T00:00:00Z', exitCode: 5 });
    expect(deliveryProjection(h.state, task)).toEqual({
      currentCandidate: { ...expected.currentCandidate, id: newer.id },
      latestCheckRun: { command: check.command, exitCode: 5 }, attemptPhase: 'finalizing',
    });
  });

  describe('WebSocket serving', () => {
    const http = createServer();
    let server: MoeWebSocketServer;
    let client: WebSocket;
    beforeEach(async () => {
      // No MCP requests in these plugin-only tests.
      server = new MoeWebSocketServer(http, h.state, {} as McpAdapter);
      http.listen(0, '127.0.0.1');
      await once(http, 'listening');
    });
    afterEach(async () => {
      client?.terminate();
      await server.close();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    });
    async function connect(): Promise<string> {
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('No server port');
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      const [raw] = await once(client, 'message');
      return String(raw);
    }
    async function update(): Promise<string> {
      const response = once(client, 'message');
      server.broadcast({ type: 'TASK_UPDATED', payload: task });
      const [raw] = await response;
      return String(raw);
    }

    it('serves identical projections on snapshots and subsequent task updates', async () => {
      seed();
      const snapshot = JSON.parse(await connect());
      expect(snapshot.payload.tasks[0]).toEqual({ ...task, delivery: expected });
      h.state.checkRuns.set('check-2', { ...check, id: 'check-2', exitCode: 0 });
      expect(JSON.parse(await update())).toEqual({
        type: 'TASK_UPDATED', payload: { ...task, delivery: { ...expected, latestCheckRun: { command: check.command, exitCode: 0 } } },
      });
      expect(h.state.tasks.get(task.id)).toBe(task);
      expect(task).not.toHaveProperty('delivery');
    });

    it('serves byte-identical legacy snapshots and updates with no evidence', async () => {
      const expectedSnapshot = JSON.stringify({ type: 'STATE_SNAPSHOT', payload: h.state.getSnapshot() });
      expect(await connect()).toBe(expectedSnapshot);
      expect(await update()).toBe(JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
    });

    it('keeps malformed evidence from breaking snapshots and still filters archived tasks', async () => {
      h.state.candidates.set('corrupt', null as unknown as Candidate);
      h.state.tasks.set('archived', { ...task, id: 'archived', status: 'ARCHIVED' });
      expect(JSON.parse(await connect()).payload.tasks).toEqual([task]);
      expect(await update()).toBe(JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
    });

    it('projects direct edit replies so they cannot erase delivery after a broadcast', async () => {
      seed();
      await connect();
      const response = once(client, 'message');
      client.send(JSON.stringify({ type: 'UPDATE_TASK', payload: { taskId: task.id, updates: { title: 'Edited' } } }));
      const [raw] = await response;
      const message = JSON.parse(String(raw));
      expect(message.type).toBe('TASK_UPDATED');
      expect(message.payload.title).toBe('Edited');
      expect(message.payload.delivery).toEqual(expected);
    });

    it('does not persist plugin-supplied delivery evidence', async () => {
      await connect();
      const response = once(client, 'message');
      client.send(JSON.stringify({ type: 'UPDATE_TASK', payload: { taskId: task.id, updates: { delivery: expected } } }));
      const [raw] = await response;
      expect(JSON.parse(String(raw)).payload).not.toHaveProperty('delivery');
      expect(h.state.tasks.get(task.id)).not.toHaveProperty('delivery');
      expect(JSON.parse(fs.readFileSync(`${h.moePath}/tasks/${task.id}.json`, 'utf8'))).not.toHaveProperty('delivery');
    });
  });
});

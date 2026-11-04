import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getSeatLivenessTool } from './getSeatLiveness.js';
import { getTools, toolsForRole, TOOL_AUDIENCE } from './index.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { openAttempt, setAttemptPhase } from '../state/attemptStore.js';
import { MoeError } from '../util/errors.js';
import type { StateManager } from '../state/StateManager.js';
import type { Worker } from '../types/schema.js';

// moe.get_seat_liveness: a wrapper-only, read-only answer to "is this seat gone?"
// Gone = no worker record (or DEAD) and openAttempts 0. An attempt can outlive
// its pruned worker record, so the attempt count is read independently.

const h = new ToolTestHarness();
beforeEach(() => h.init());
afterEach(() => h.cleanup());

const tool = () => getSeatLivenessTool(h.state);
const call = (args: unknown) => tool().handler(args as Record<string, unknown>, h.state);

async function addWorker(id: string, status: Worker['status'] = 'IDLE'): Promise<void> {
  await h.state.createWorker({
    id,
    type: 'CLAUDE',
    projectId: 'proj-test',
    epicId: 'epic-1',
    currentTaskId: null,
    status,
  });
}

async function seedAttempt(taskId: string, workerId: string, phase?: 'finalizing' | 'reconciling' | 'closed') {
  const attempt = await openAttempt(h.state, { taskId, workerId, runnerId: `runner-${workerId}`, workspace: h.testDir });
  if (phase) await setAttemptPhase(h.state, attempt.id, phase);
  return attempt;
}

beforeEach(async () => {
  h.setupMoeFolder({ schemaVersion: 6 } as never);
  h.createEpic();
  for (let i = 1; i <= 5; i += 1) h.createTask({ id: `task-${i}`, status: 'WORKING' });
  await h.state.load();
});

describe('moe.get_seat_liveness answers', () => {
  it('reports an unknown worker as not registered with no attempts', async () => {
    expect(await call({ workerId: 'worker-x' })).toEqual({
      workerId: 'worker-x',
      registered: false,
      status: null,
      openAttempts: 0,
    });
  });

  it('reports a registered worker with its status, DEAD included', async () => {
    await addWorker('worker-idle', 'IDLE');
    await addWorker('worker-dead', 'DEAD');
    expect(await call({ workerId: 'worker-idle' })).toEqual({
      workerId: 'worker-idle',
      registered: true,
      status: 'IDLE',
      openAttempts: 0,
    });
    expect(await call({ workerId: 'worker-dead' })).toEqual({
      workerId: 'worker-dead',
      registered: true,
      status: 'DEAD',
      openAttempts: 0,
    });
  });

  it('answers prototype-name ids as not registered', async () => {
    for (const id of ['constructor', 'toString', '__proto__']) {
      expect(await call({ workerId: id })).toEqual({ workerId: id, registered: false, status: null, openAttempts: 0 });
    }
  });

  it('counts running, finalizing and reconciling attempts, not closed or foreign ones', async () => {
    await addWorker('worker-1');
    await addWorker('worker-2');
    await seedAttempt('task-1', 'worker-1');
    await seedAttempt('task-2', 'worker-1', 'finalizing');
    await seedAttempt('task-3', 'worker-1', 'reconciling');
    await seedAttempt('task-4', 'worker-1', 'closed');
    await seedAttempt('task-5', 'worker-2');
    expect(await call({ workerId: 'worker-1' })).toEqual({
      workerId: 'worker-1',
      registered: true,
      status: 'IDLE',
      openAttempts: 3,
    });
    expect(await call({ workerId: 'worker-2' })).toMatchObject({ openAttempts: 1 });
  });

  it('still counts an open attempt whose worker record is gone', async () => {
    await seedAttempt('task-1', 'worker-gone', 'finalizing');
    expect(await call({ workerId: 'worker-gone' })).toEqual({
      workerId: 'worker-gone',
      registered: false,
      status: null,
      openAttempts: 1,
    });
  });
});

function snapshotFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

describe('moe.get_seat_liveness is read-only', () => {
  it('changes no file and no worker field', async () => {
    await addWorker('worker-1');
    h.state.workers.get('worker-1')!.lastActivityAt = '2020-01-01T00:00:00.000Z';
    await seedAttempt('task-1', 'worker-1');
    await seedAttempt('task-2', 'worker-gone');

    const filesBefore = snapshotFiles(h.moePath);
    const workerBefore = structuredClone(h.state.workers.get('worker-1'));
    expect(Object.keys(filesBefore).length).toBeGreaterThan(0);

    await call({ workerId: 'worker-1' });
    await call({ workerId: 'worker-gone' });
    await call({ workerId: 'worker-unknown' });

    expect(snapshotFiles(h.moePath)).toEqual(filesBefore);
    expect(h.state.workers.get('worker-1')).toEqual(workerBefore);
    expect(h.state.workers.get('worker-1')!.lastActivityAt).toBe('2020-01-01T00:00:00.000Z');
    expect(h.state.workers.has('worker-unknown')).toBe(false);
  });
});

describe('moe.get_seat_liveness refuses a malformed workerId', () => {
  const bad: Array<[string, unknown]> = [
    ['no args', undefined],
    ['null args', null],
    ['empty object', {}],
    ['number', { workerId: 42 }],
    ['empty string', { workerId: '' }],
    ['blank string', { workerId: '   ' }],
    ['over-long (256)', { workerId: 'w'.repeat(256) }],
    ['newline', { workerId: 'w\nx' }],
    ['DEL', { workerId: 'w\u007fx' }],
  ];
  for (const [label, args] of bad) {
    it(`rejects ${label} with INVALID_INPUT`, async () => {
      const err = await call(args).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).codeName).toBe('INVALID_INPUT');
    });
  }

  it('accepts a 255-char id', async () => {
    const id = 'w'.repeat(255);
    expect(await call({ workerId: id })).toEqual({ workerId: id, registered: false, status: null, openAttempts: 0 });
  });
});

describe('moe.get_seat_liveness registration', () => {
  it('is registered, wrapper-only, and absent from every seat tools/list', () => {
    const tools = getTools({} as StateManager);
    expect(tools.map((t) => t.name)).toContain('moe.get_seat_liveness');
    expect(TOOL_AUDIENCE['moe.get_seat_liveness']).toBe('wrapper');
    for (const role of ['architect', 'worker', 'qa', 'governor'] as const) {
      expect(toolsForRole(tools, role).map((t) => t.name)).not.toContain('moe.get_seat_liveness');
    }
  });
});

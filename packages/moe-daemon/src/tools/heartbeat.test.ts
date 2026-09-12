import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { heartbeatTool } from './heartbeat.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { openAttempt, setAttemptPhase } from '../state/attemptStore.js';
import { MoeError } from '../util/errors.js';
import type { AttemptPresenceKind, ExecutionAttempt } from '../types/schema.js';

// =============================================================================
// moe.heartbeat — a presence ping that can also demand reattachment.
//
// Two contracts live here and neither may drift:
//  - The ping keeps refreshing lastActivityAt for a live worker, because a long
//    silent build is not evidence of a dead worker and the REVIEW self-heal
//    depends on that refresh.
//  - Presence is recorded WITHOUT touching the attempt's lastPhaseAt. The
//    reconcile-window sweep (state/sweeps.ts) measures its window from exactly
//    that field, so a 60s ping that refreshed it would make a reconciling
//    attempt immortal and silently disable the sweep. The lastPhaseAt cases
//    below assert the STORED value, not merely that the phase string is
//    unchanged — that is the only assertion that catches the "reuse
//    setAttemptPhase" mistake.
// =============================================================================

const h = new ToolTestHarness();
beforeEach(() => h.init());
afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

interface HeartbeatAck { ok: true }
interface HeartbeatReattach {
  ok: false;
  reattachRequired: true;
  reason: string;
  reattachWith: string;
  attemptId?: string;
  phase?: string;
}
type HeartbeatResult = HeartbeatAck | HeartbeatReattach;

describe('moe.heartbeat', () => {
  const tool = () => heartbeatTool(h.state);

  function attemptFile(id: string): string {
    return path.join(h.moePath, 'attempts', `${id}.json`);
  }

  function readAttempt(id: string): ExecutionAttempt {
    return JSON.parse(fs.readFileSync(attemptFile(id), 'utf8')) as ExecutionAttempt;
  }

  /** A live seat: worker owns task-hb, task-hb has one `running` attempt. */
  async function seedRunningAttempt(
    overrides: { attemptWorkerId?: string } = {}
  ): Promise<ExecutionAttempt> {
    return openAttempt(h.state, {
      id: 'attempt-hb-1',
      taskId: 'task-hb',
      workerId: overrides.attemptWorkerId ?? 'worker-hb',
      runnerId: 'runner-hb',
      workspace: h.testDir,
    });
  }

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-hb', status: 'WORKING', assignedWorkerId: 'worker-hb' });
    await h.state.load();
    await h.state.createWorker({
      id: 'worker-hb',
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId: 'task-hb',
      status: 'CODING',
    });
  });

  // ---------------------------------------------------------------------------
  // The original job: keep lastActivityAt fresh.
  // ---------------------------------------------------------------------------

  it('refreshes lastActivityAt for a live worker', async () => {
    await seedRunningAttempt();
    const before = h.state.getWorker('worker-hb')!.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await tool().handler({ workerId: 'worker-hb' }, h.state) as HeartbeatResult;

    expect(result).toEqual({ ok: true });
    expect(new Date(h.state.getWorker('worker-hb')!.lastActivityAt).getTime())
      .toBeGreaterThan(new Date(before).getTime());
  });

  it('still refreshes lastActivityAt when it answers reattach-required', async () => {
    // The worker exists but owns no attempt. touchWorker must STILL run: the
    // refresh is what keeps a long silent build from looking dead, and that is
    // independent of whether the runner has to reattach.
    const before = h.state.getWorker('worker-hb')!.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await tool().handler({ workerId: 'worker-hb' }, h.state) as HeartbeatReattach;

    expect(result.reattachRequired).toBe(true);
    expect(new Date(h.state.getWorker('worker-hb')!.lastActivityAt).getTime())
      .toBeGreaterThan(new Date(before).getTime());
  });

  it('does not resurrect a DEAD worker', async () => {
    await h.state.createWorker({
      id: 'worker-hb-dead',
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId: null,
      status: 'DEAD',
    });
    const before = h.state.getWorker('worker-hb-dead')!.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    await tool().handler({ workerId: 'worker-hb-dead' }, h.state);

    expect(h.state.getWorker('worker-hb-dead')!.lastActivityAt).toBe(before);
    expect(h.state.getWorker('worker-hb-dead')!.status).toBe('DEAD');
  });

  // ---------------------------------------------------------------------------
  // Presence kinds.
  // ---------------------------------------------------------------------------

  it.each<AttemptPresenceKind>(['process', 'provider', 'waiting', 'progress'])(
    'records presence kind %s on the caller\'s open attempt',
    async (kind) => {
      await seedRunningAttempt();

      const result = await tool().handler(
        { workerId: 'worker-hb', presenceKind: kind },
        h.state
      ) as HeartbeatResult;

      expect(result).toEqual({ ok: true });
      const stored = readAttempt('attempt-hb-1');
      expect(stored.presenceKind).toBe(kind);
      expect(typeof stored.presenceAt).toBe('string');
      expect(Number.isNaN(Date.parse(stored.presenceAt!))).toBe(false);
      // Published state and disk agree.
      expect(h.state.attempts.get('attempt-hb-1')!.presenceKind).toBe(kind);
    }
  );

  it('keeps the latest presence kind when two pings arrive in sequence', async () => {
    await seedRunningAttempt();

    await tool().handler({ workerId: 'worker-hb', presenceKind: 'process' }, h.state);
    expect(readAttempt('attempt-hb-1').presenceKind).toBe('process');

    await tool().handler({ workerId: 'worker-hb', presenceKind: 'waiting' }, h.state);
    expect(readAttempt('attempt-hb-1').presenceKind).toBe('waiting');
  });

  it('refuses a presence kind outside the four as invalid input', async () => {
    await seedRunningAttempt();

    await expect(
      tool().handler({ workerId: 'worker-hb', presenceKind: 'alive' }, h.state)
    ).rejects.toThrow(MoeError);

    // Nothing stored, not even a timestamp.
    const stored = readAttempt('attempt-hb-1');
    expect(stored.presenceKind).toBeUndefined();
    expect(stored.presenceAt).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // The reconcile-window regression guard. This is the case that catches a
  // presence write routed through setAttemptPhase.
  // ---------------------------------------------------------------------------

  it('leaves lastPhaseAt byte-identical when it records presence', async () => {
    const attempt = await seedRunningAttempt();
    const phaseAtBefore = readAttempt('attempt-hb-1').lastPhaseAt;
    expect(phaseAtBefore).toBe(attempt.lastPhaseAt);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await tool().handler({ workerId: 'worker-hb', presenceKind: 'progress' }, h.state);

    const after = readAttempt('attempt-hb-1');
    expect(after.lastPhaseAt).toBe(phaseAtBefore);
    expect(after.phase).toBe('running');
    expect(h.state.attempts.get('attempt-hb-1')!.lastPhaseAt).toBe(phaseAtBefore);
  });

  // ---------------------------------------------------------------------------
  // Un-upgraded wrapper compatibility: no presence kind, no extra write.
  // ---------------------------------------------------------------------------

  it('succeeds unchanged for an old-style ping carrying no presence kind', async () => {
    await seedRunningAttempt();

    const result = await tool().handler({ workerId: 'worker-hb' }, h.state) as HeartbeatResult;

    expect(result).toEqual({ ok: true });
    expect(readAttempt('attempt-hb-1').presenceKind).toBeUndefined();
  });

  it('writes nothing to the attempt file when no presence kind is supplied', async () => {
    await seedRunningAttempt();
    const before = fs.readFileSync(attemptFile('attempt-hb-1'), 'utf8');
    const mtimeBefore = fs.statSync(attemptFile('attempt-hb-1')).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));

    await tool().handler({ workerId: 'worker-hb' }, h.state);

    expect(fs.readFileSync(attemptFile('attempt-hb-1'), 'utf8')).toBe(before);
    expect(fs.statSync(attemptFile('attempt-hb-1')).mtimeMs).toBe(mtimeBefore);
  });

  // ---------------------------------------------------------------------------
  // The three reattach-required conditions.
  // ---------------------------------------------------------------------------

  it('tells a ping with no worker record to reattach, and creates nothing', async () => {
    const result = await tool().handler(
      { workerId: 'worker-does-not-exist', presenceKind: 'process' },
      h.state
    ) as HeartbeatReattach;

    expect(result.ok).toBe(false);
    expect(result.reattachRequired).toBe(true);
    expect(result.reason).toBe('no-worker-record');
    expect(result.reattachWith).toBe('moe.reattach_attempt');
    expect(result.attemptId).toBeUndefined();
    // Nothing resurrected, nothing invented.
    expect(h.state.getWorker('worker-does-not-exist')).toBeNull();
    expect(fs.existsSync(path.join(h.moePath, 'workers', 'worker-does-not-exist.json'))).toBe(false);
  });

  it('tells a ping whose worker owns no open attempt to reattach', async () => {
    const result = await tool().handler(
      { workerId: 'worker-hb', presenceKind: 'process' },
      h.state
    ) as HeartbeatReattach;

    expect(result.ok).toBe(false);
    expect(result.reattachRequired).toBe(true);
    expect(result.reason).toBe('no-open-attempt');
    expect(result.reattachWith).toBe('moe.reattach_attempt');
  });

  it('tells a ping whose only attempt is closed to reattach', async () => {
    await seedRunningAttempt();
    await setAttemptPhase(h.state, 'attempt-hb-1', 'closed');

    const result = await tool().handler(
      { workerId: 'worker-hb', presenceKind: 'process' },
      h.state
    ) as HeartbeatReattach;

    expect(result.reason).toBe('no-open-attempt');
    expect(readAttempt('attempt-hb-1').presenceKind).toBeUndefined();
  });

  it('never records presence on an attempt belonging to another worker', async () => {
    await seedRunningAttempt({ attemptWorkerId: 'worker-other' });

    const result = await tool().handler(
      { workerId: 'worker-hb', presenceKind: 'progress' },
      h.state
    ) as HeartbeatReattach;

    expect(result.reason).toBe('no-open-attempt');
    expect(readAttempt('attempt-hb-1').presenceKind).toBeUndefined();
  });

  it('tells a ping against a reconciling attempt to reattach and records no presence', async () => {
    await seedRunningAttempt();
    await setAttemptPhase(h.state, 'attempt-hb-1', 'reconciling');
    const phaseAtBefore = readAttempt('attempt-hb-1').lastPhaseAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await tool().handler(
      { workerId: 'worker-hb', presenceKind: 'provider' },
      h.state
    ) as HeartbeatReattach;

    expect(result.ok).toBe(false);
    expect(result.reattachRequired).toBe(true);
    expect(result.reason).toBe('attempt-reconciling');
    expect(result.attemptId).toBe('attempt-hb-1');
    expect(result.phase).toBe('reconciling');
    expect(result.reattachWith).toBe('moe.reattach_attempt');

    // A runner that has not proven it is there does not get to look present —
    // and the reconcile window it is being measured against is untouched.
    const stored = readAttempt('attempt-hb-1');
    expect(stored.presenceKind).toBeUndefined();
    expect(stored.lastPhaseAt).toBe(phaseAtBefore);
  });
});

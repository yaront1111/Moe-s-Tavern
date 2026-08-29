// Tests for the dependency auto-unblock module: the event-driven hook on
// DONE/ARCHIVED transitions, the sweep backstop that repairs UNASSIGNED rows,
// the resource-row exclusion, and the dep-less stale-block governor alert.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';
import { archiveTaskTool } from '../tools/archiveTask.js';
import {
  DEPENDENCY_WAIT_ALERT_MULTIPLIER,
  alertStaleBlocks,
  findDependencyPath,
  formatDependencyCycle,
  isDependencySatisfied,
  runDependencyUnblock,
  unmetBlockedOnTaskIds,
  unmetDependsOn,
} from './dependencyUnblock.js';
import { runBlockedTimeoutSweep } from './sweeps.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';

describe('dependencyUnblock', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
  });

  describe('predicates', () => {
    it('a missing/deleted id counts as satisfied; DONE and ARCHIVED are satisfied; anything else is not', async () => {
      h.createTask({ id: 'task-d0ne00', status: 'DONE' });
      h.createTask({ id: 'task-a4c1ed', status: 'ARCHIVED' });
      h.createTask({ id: 'task-w04k1n', status: 'WORKING' });
      await h.state.load();

      expect(isDependencySatisfied(h.state, 'task-d0ne00')).toBe(true);
      expect(isDependencySatisfied(h.state, 'task-a4c1ed')).toBe(true);
      expect(isDependencySatisfied(h.state, 'task-gone')).toBe(true);
      expect(isDependencySatisfied(h.state, 'task-w04k1n')).toBe(false);

      expect(unmetDependsOn(h.state, { dependsOn: ['task-d0ne00', 'task-w04k1n', 'task-gone'] }))
        .toEqual(['task-w04k1n']);
      expect(unmetBlockedOnTaskIds(h.state, { blockedOnTaskIds: ['task-w04k1n'] }))
        .toEqual(['task-w04k1n']);
      expect(unmetDependsOn(h.state, {})).toEqual([]);
    });

    it('findDependencyPath walks dependsOn ∪ blockedOnTaskIds and stops at DONE/ARCHIVED nodes', async () => {
      h.createTask({ id: 'task-aaaaaa', status: 'WORKING', dependsOn: ['task-bbbbbb'] } as never);
      h.createTask({
        id: 'task-bbbbbb', status: 'BLOCKED', blockedOnTaskIds: ['task-cccccc'],
        blockedFromStatus: 'WORKING', blockedReason: 'r', blockedAt: new Date().toISOString(),
      } as never);
      h.createTask({ id: 'task-cccccc', status: 'WORKING' });
      // A DONE node's outgoing edges are dead: dddddd → aaaaaa is never followed.
      h.createTask({ id: 'task-dddddd', status: 'DONE', dependsOn: ['task-aaaaaa'] } as never);
      await h.state.load();

      expect(findDependencyPath(h.state, 'task-aaaaaa', 'task-cccccc'))
        .toEqual(['task-aaaaaa', 'task-bbbbbb', 'task-cccccc']);
      expect(findDependencyPath(h.state, 'task-aaaaaa', 'task-aaaaaa')).toEqual(['task-aaaaaa']);
      expect(findDependencyPath(h.state, 'task-cccccc', 'task-aaaaaa')).toBeNull();
      expect(findDependencyPath(h.state, 'task-dddddd', 'task-aaaaaa')).toBeNull();
      expect(findDependencyPath(h.state, 'task-gone', 'task-aaaaaa')).toBeNull();
      expect(formatDependencyCycle('task-cccccc', ['task-aaaaaa', 'task-bbbbbb', 'task-cccccc']))
        .toBe('task-cccccc → task-aaaaaa → task-bbbbbb → task-cccccc');
    });
  });

  describe('event-driven unblock (updateTask hook)', () => {
    function blockedRow(id: string, deps: string[], overrides: Record<string, unknown> = {}) {
      h.createTask({
        id,
        status: 'BLOCKED',
        assignedWorkerId: null,
        blockedReason: `waiting on ${deps.join(', ')}`,
        blockedOnTaskIds: deps,
        blockedFromStatus: 'WORKING',
        blockedAt: new Date().toISOString(),
        ...overrides,
      } as never);
    }

    it('qa_approve DONE transition restores a dependent BLOCKED row to blockedFromStatus', async () => {
      h.createTask({ id: 'task-p4e4eq', status: 'REVIEW', assignedWorkerId: null });
      blockedRow('task-b10ced', ['task-p4e4eq'], { blockedFromStatus: 'WORKING' });
      await h.state.load();

      await qaApproveTool(h.state).handler(
        { taskId: 'task-p4e4eq', summary: 'verified: build green' }, h.state
      );

      const restored = h.state.getTask('task-b10ced')!;
      expect(restored.status).toBe('WORKING');
      expect(restored.blockedReason).toBeNull();
      expect(restored.blockedOnTaskIds).toBeNull();
      expect(restored.blockedFromStatus).toBeNull();
      expect(restored.blockedAt).toBeNull();
      // Seat-freed rows return UNASSIGNED — claimable by anyone.
      expect(restored.assignedWorkerId).toBeNull();
    });

    it('set_task_status → DONE and archive_task → ARCHIVED both trigger the unblock', async () => {
      h.createTask({ id: 'task-4ev1ew', status: 'REVIEW' });
      h.createTask({ id: 'task-backl0', status: 'BACKLOG' });
      blockedRow('task-need2b', ['task-4ev1ew', 'task-backl0'], { blockedFromStatus: 'PLANNING' });
      await h.state.load();

      // First dep lands DONE — second still unmet, row stays BLOCKED.
      await setTaskStatusTool(h.state).handler({ taskId: 'task-4ev1ew', status: 'DONE' }, h.state);
      expect(h.state.getTask('task-need2b')!.status).toBe('BLOCKED');

      // Second dep is ARCHIVED — all satisfied, restore to blockedFromStatus.
      await archiveTaskTool(h.state).handler({ taskId: 'task-backl0' }, h.state);
      expect(h.state.getTask('task-need2b')!.status).toBe('PLANNING');
    });

    it('a resource-parked BLOCKED row is NEVER touched (the grant path owns it)', async () => {
      h.createTask({ id: 'task-p4e4eq', status: 'REVIEW' });
      blockedRow('task-4e50u4', ['task-p4e4eq'], { blockedResourceId: 'benchmark-box' });
      await h.state.load();

      await setTaskStatusTool(h.state).handler({ taskId: 'task-p4e4eq', status: 'DONE' }, h.state);

      const still = h.state.getTask('task-4e50u4')!;
      expect(still.status).toBe('BLOCKED');
      expect(still.blockedResourceId).toBe('benchmark-box');
    });

    it('a BLOCKED row without blockedOnTaskIds is never auto-unblocked', async () => {
      h.createTask({ id: 'task-p4e4eq', status: 'REVIEW' });
      blockedRow('task-manual', [], { blockedOnTaskIds: undefined });
      await h.state.load();

      await setTaskStatusTool(h.state).handler({ taskId: 'task-p4e4eq', status: 'DONE' }, h.state);
      expect(h.state.getTask('task-manual')!.status).toBe('BLOCKED');
    });

    it('a still-assigned hold returns to its parked worker (grantNextLeases parity)', async () => {
      h.createTask({ id: 'task-p4e4eq', status: 'REVIEW' });
      blockedRow('task-1egacy', ['task-p4e4eq'], { assignedWorkerId: 'worker-parked' });
      h.createWorker({ id: 'worker-parked', status: 'BLOCKED', currentTaskId: 'task-1egacy' });
      await h.state.load();

      await setTaskStatusTool(h.state).handler({ taskId: 'task-p4e4eq', status: 'DONE' }, h.state);

      const restored = h.state.getTask('task-1egacy')!;
      expect(restored.status).toBe('WORKING');
      expect(restored.assignedWorkerId).toBe('worker-parked');
    });

    it('a still-assigned hold whose owner is DEAD, IDLE-with-no-pointer, or missing returns UNASSIGNED', async () => {
      // Restoring onto a corpse makes the row permanently unclaimable
      // (isTaskClaimable needs the owner missing or DEAD — an IDLE record is
      // neither) while the Layer-3 prune keeps the "owner of active work".
      h.createTask({ id: 'task-p4e4eq', status: 'REVIEW' });
      blockedRow('task-dead01', ['task-p4e4eq'], { assignedWorkerId: 'worker-dead' });
      blockedRow('task-idle01', ['task-p4e4eq'], { assignedWorkerId: 'worker-idle' });
      blockedRow('task-gone01', ['task-p4e4eq'], { assignedWorkerId: 'worker-gone' });
      blockedRow('task-other1', ['task-p4e4eq'], { assignedWorkerId: 'worker-elsewhere' });
      h.createWorker({ id: 'worker-dead', status: 'DEAD', currentTaskId: 'task-dead01' });
      h.createWorker({ id: 'worker-idle', status: 'IDLE', currentTaskId: null });
      // Pointer names a DIFFERENT task: not a genuine hold on this row either.
      h.createWorker({ id: 'worker-elsewhere', status: 'CODING', currentTaskId: 'task-p4e4eq' });
      await h.state.load();

      await setTaskStatusTool(h.state).handler({ taskId: 'task-p4e4eq', status: 'DONE' }, h.state);

      for (const id of ['task-dead01', 'task-idle01', 'task-gone01', 'task-other1']) {
        const restored = h.state.getTask(id)!;
        expect(restored.status).toBe('WORKING');
        expect(restored.assignedWorkerId).toBeNull();
        expect(h.state.isTaskClaimable(restored)).toBe(true);
      }
    });

    it('routes a garbage blockedFromStatus to WORKING instead of recursing', async () => {
      h.createTask({ id: 'task-p4e4eq', status: 'REVIEW' });
      blockedRow('task-w0nky1', ['task-p4e4eq'], { blockedFromStatus: 'DONE' });
      await h.state.load();

      await setTaskStatusTool(h.state).handler({ taskId: 'task-p4e4eq', status: 'DONE' }, h.state);
      expect(h.state.getTask('task-w0nky1')!.status).toBe('WORKING');
    });

    it('posts an un-block notice to chat', async () => {
      h.createTask({ id: 'task-p4e4eq', status: 'REVIEW' });
      blockedRow('task-ch4tty', ['task-p4e4eq']);
      await h.state.load();
      const general: string[] = [];
      vi.spyOn(h.state, 'postToGeneral').mockImplementation(async (msg: string) => { general.push(msg); });

      await setTaskStatusTool(h.state).handler({ taskId: 'task-p4e4eq', status: 'DONE' }, h.state);
      expect(general.some((m) => m.includes('task-ch4tty') && m.includes('un-blocked'))).toBe(true);
    });
  });

  describe('sweep backstop (runBlockedTimeoutSweep)', () => {
    it('repairs an UNASSIGNED pre-existing BLOCKED row whose deps are already DONE', async () => {
      // The prerequisite was DONE before anything watched for it — the
      // event-driven hook never fired. Only the sweep can repair this row.
      h.createTask({ id: 'task-a14ead', status: 'DONE' });
      h.createTask({
        id: 'task-5tuck1',
        status: 'BLOCKED',
        assignedWorkerId: null,
        blockedReason: 'BUILD-ORDER BLOCK on task-a14ead',
        blockedOnTaskIds: ['task-a14ead'],
        blockedFromStatus: 'WORKING',
        blockedAt: new Date().toISOString(),
      } as never);
      // A resource-waiting row with satisfied deps must be SKIPPED by this pass.
      h.createTask({
        id: 'task-4e5wa1',
        status: 'BLOCKED',
        assignedWorkerId: null,
        blockedReason: 'waiting on the box',
        blockedOnTaskIds: ['task-a14ead'],
        blockedResourceId: 'benchmark-box',
        blockedFromStatus: 'WORKING',
        blockedAt: new Date().toISOString(),
      } as never);
      await h.state.load();

      await h.state.mutex.runExclusive(() => runBlockedTimeoutSweep(h.state));

      expect(h.state.getTask('task-5tuck1')!.status).toBe('WORKING');
      expect(h.state.getTask('task-5tuck1')!.assignedWorkerId).toBeNull();
      expect(h.state.getTask('task-4e5wa1')!.status).toBe('BLOCKED');
    });

    it('blocked-worker timeout parks a dep-less BLOCKED hold but keeps a dependency-waiting one BLOCKED — and UNASSIGNS it', async () => {
      // Still-assigned holds under a timed-out BLOCKED worker: the park arm
      // (BLOCKED → BACKLOG) must not park a row with blockedOnTaskIds — the
      // dependency auto-unblock only scans BLOCKED rows, so a park would
      // strand it past its deps landing. But the SEAT must go: left assigned
      // to the now-IDLE corpse, the auto-unblock would restore the row onto
      // it — unclaimable by anyone and unprunable — until a daemon restart.
      const staleTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      h.createTask({ id: 'task-w04k1n', status: 'REVIEW' });
      h.createTask({
        id: 'task-dep4o1', status: 'BLOCKED', assignedWorkerId: 'worker-t1meout',
        blockedReason: 'waiting on task-w04k1n', blockedOnTaskIds: ['task-w04k1n'],
        blockedFromStatus: 'WORKING', blockedAt: staleTs,
      } as never);
      h.createTask({
        id: 'task-n0dep1', status: 'BLOCKED', assignedWorkerId: 'worker-t1meout',
        blockedReason: 'needs a human decision',
        blockedFromStatus: 'WORKING', blockedAt: staleTs,
      } as never);
      h.createWorker({ id: 'worker-t1meout', status: 'BLOCKED', currentTaskId: 'task-dep4o1', lastActivityAt: staleTs });
      h.createWorker({ id: 'worker-fresh1', status: 'IDLE', currentTaskId: null });
      await h.state.load();

      await h.state.mutex.runExclusive(() => runBlockedTimeoutSweep(h.state));

      // Dep-waiting hold: not parked — stays BLOCKED (deps unmet) with its
      // block bookkeeping, but the seat is released.
      const depRow = h.state.getTask('task-dep4o1')!;
      expect(depRow.status).toBe('BLOCKED');
      expect(depRow.blockedOnTaskIds).toEqual(['task-w04k1n']);
      expect(depRow.assignedWorkerId).toBeNull();
      // Dep-less hold: parked to BACKLOG for human triage (unchanged behavior).
      expect(h.state.getTask('task-n0dep1')!.status).toBe('BACKLOG');
      // The timed-out worker itself is still released to IDLE.
      expect(h.state.getWorker('worker-t1meout')!.status).toBe('IDLE');

      // The dep lands → the row returns WORKING-unassigned and another worker
      // can claim it (the starvation the old skip produced).
      await setTaskStatusTool(h.state).handler({ taskId: 'task-w04k1n', status: 'DONE' }, h.state);
      const restored = h.state.getTask('task-dep4o1')!;
      expect(restored.status).toBe('WORKING');
      expect(restored.assignedWorkerId).toBeNull();
      const claim = await claimNextTaskTool(h.state).handler(
        { workerId: 'worker-fresh1', statuses: ['WORKING'] }, h.state
      ) as { hasNext: boolean; task?: { id: string } };
      expect(claim.hasNext).toBe(true);
      expect(claim.task?.id).toBe('task-dep4o1');
    });

    it('runDependencyUnblock returns the repaired ids and leaves unmet rows alone', async () => {
      h.createTask({ id: 'task-d0ne00', status: 'DONE' });
      h.createTask({ id: 'task-w04k1n', status: 'WORKING' });
      h.createTask({
        id: 'task-4eady1', status: 'BLOCKED', blockedOnTaskIds: ['task-d0ne00'],
        blockedFromStatus: 'REVIEW', blockedReason: 'r', blockedAt: new Date().toISOString(),
      } as never);
      h.createTask({
        id: 'task-n0tyet', status: 'BLOCKED', blockedOnTaskIds: ['task-w04k1n'],
        blockedFromStatus: 'WORKING', blockedReason: 'r', blockedAt: new Date().toISOString(),
      } as never);
      await h.state.load();

      const unblocked = await runDependencyUnblock(h.state);
      expect(unblocked).toEqual(['task-4eady1']);
      expect(h.state.getTask('task-4eady1')!.status).toBe('REVIEW');
      expect(h.state.getTask('task-n0tyet')!.status).toBe('BLOCKED');
    });
  });

  describe('stale-block alert', () => {
    const HOUR = 60 * 60 * 1000;
    function staleDeplessRow(id: string, ageMs: number) {
      h.createTask({
        id,
        status: 'BLOCKED',
        blockedReason: 'needs a human decision',
        blockedFromStatus: 'WORKING',
        blockedAt: new Date(Date.now() - ageMs).toISOString(),
      } as never);
    }
    function staleDepRow(id: string, deps: string[], ageMs: number, overrides: Record<string, unknown> = {}) {
      h.createTask({
        id, status: 'BLOCKED', blockedReason: `waiting on ${deps.join(', ')}`,
        blockedOnTaskIds: deps, blockedFromStatus: 'WORKING',
        blockedAt: new Date(Date.now() - ageMs).toISOString(),
        ...overrides,
      } as never);
    }
    function captureRolePosts(): Array<[string, string]> {
      const roleMsgs: Array<[string, string]> = [];
      vi.spyOn(h.state, 'postToRoleChannel').mockImplementation(async (role: string, msg: string) => {
        roleMsgs.push([role, msg]);
      });
      return roleMsgs;
    }

    it('alerts #governors once per block instance for dep-less stale rows — alert only, never a park', async () => {
      staleDeplessRow('task-5ta1e1', 2 * HOUR); // > default 1h timeout
      staleDeplessRow('task-f4e5h1', 60 * 1000); // fresh — no alert
      // Stale but WITH a MOVING dep, under the 2× bound → the unblock path
      // owns it, no alert.
      staleDepRow('task-ha5dep', ['task-w04k1n'], 1.5 * HOUR);
      h.createTask({ id: 'task-w04k1n', status: 'WORKING' });
      await h.state.load();
      const roleMsgs = captureRolePosts();

      const first = await alertStaleBlocks(h.state);
      expect(first).toBe(1);
      expect(roleMsgs).toHaveLength(1);
      expect(roleMsgs[0][0]).toBe('governors');
      expect(roleMsgs[0][1]).toContain('task-5ta1e1');
      expect(roleMsgs[0][1]).toContain('nothing will auto-unblock it');

      // Second pass: memoized — no re-page.
      const second = await alertStaleBlocks(h.state);
      expect(second).toBe(0);
      expect(roleMsgs).toHaveLength(1);

      // Alert only: the row is still BLOCKED, still parked in place.
      expect(h.state.getTask('task-5ta1e1')!.status).toBe('BLOCKED');
    });

    it('alerts a dep-waiting row past the timeout whose prerequisite is itself BLOCKED or BACKLOG (cycle / parked prereq)', async () => {
      // A mutual block: nothing will ever land, and pre-fix nothing ever paged.
      staleDepRow('task-a1a1a1', ['task-b2b2b2'], 3 * HOUR);
      staleDepRow('task-b2b2b2', ['task-a1a1a1'], 3 * HOUR);
      // A prerequisite parked in BACKLOG that no human ever promotes.
      staleDepRow('task-w41t5b', ['task-backl0'], 1.5 * HOUR);
      h.createTask({ id: 'task-backl0', status: 'BACKLOG' });
      // Mixed: one moving dep, one BACKLOG dep — still cannot auto-unblock.
      staleDepRow('task-m1xed1', ['task-w04k1n', 'task-backl0'], 1.5 * HOUR);
      h.createTask({ id: 'task-w04k1n', status: 'WORKING' });
      // Fresh cycle under the timeout: no alert yet.
      staleDepRow('task-c3c3c3', ['task-d4d4d4'], 10 * 60 * 1000);
      staleDepRow('task-d4d4d4', ['task-c3c3c3'], 10 * 60 * 1000);
      // Resource-parked rows are never this pass's business.
      staleDepRow('task-4e50u4', ['task-backl0'], 3 * HOUR, { blockedResourceId: 'benchmark-box' });
      await h.state.load();
      const roleMsgs = captureRolePosts();

      const alerted = await alertStaleBlocks(h.state);
      expect(alerted).toBe(4);
      const byTask = (id: string) => roleMsgs.find(([, m]) => m.startsWith(`⚠️ ${id} `))?.[1];
      expect(byTask('task-a1a1a1')).toContain('task-b2b2b2 [BLOCKED]');
      expect(byTask('task-a1a1a1')).toContain('dependency cycle');
      expect(byTask('task-b2b2b2')).toContain('task-a1a1a1 [BLOCKED]');
      expect(byTask('task-w41t5b')).toContain('task-backl0 [BACKLOG]');
      expect(byTask('task-m1xed1')).toContain('task-w04k1n [WORKING]');
      expect(byTask('task-m1xed1')).toContain('prerequisite(s) task-backl0 are BLOCKED/BACKLOG');
      expect(byTask('task-c3c3c3')).toBeUndefined();
      expect(byTask('task-4e50u4')).toBeUndefined();
      for (const id of ['task-a1a1a1', 'task-b2b2b2', 'task-w41t5b', 'task-m1xed1']) {
        expect(h.state.getTask(id)!.status).toBe('BLOCKED'); // alert only
      }
    });

    it('alerts a dep-waiting row on MOVING prerequisites only past the general age bound', async () => {
      staleDepRow('task-pat1en', ['task-w04k1n'], (DEPENDENCY_WAIT_ALERT_MULTIPLIER - 0.5) * HOUR);
      staleDepRow('task-t00o1d', ['task-w04k1n'], (DEPENDENCY_WAIT_ALERT_MULTIPLIER + 1) * HOUR);
      h.createTask({ id: 'task-w04k1n', status: 'WORKING' });
      await h.state.load();
      const roleMsgs = captureRolePosts();

      expect(await alertStaleBlocks(h.state)).toBe(1);
      expect(roleMsgs[0][1]).toContain('task-t00o1d');
      expect(roleMsgs[0][1]).toContain('task-w04k1n [WORKING]');
      expect(roleMsgs[0][1]).toContain('the blocked timeout');
    });

    it('the blocked-timeout sweep runs the extended alert pass', async () => {
      staleDepRow('task-a1a1a1', ['task-b2b2b2'], 3 * HOUR);
      staleDepRow('task-b2b2b2', ['task-a1a1a1'], 3 * HOUR);
      await h.state.load();
      const roleMsgs = captureRolePosts();

      await h.state.mutex.runExclusive(() => runBlockedTimeoutSweep(h.state));

      expect(roleMsgs.filter(([role]) => role === 'governors')).toHaveLength(2);
      expect(h.state.getTask('task-a1a1a1')!.status).toBe('BLOCKED');
      expect(h.state.getTask('task-b2b2b2')!.status).toBe('BLOCKED');
    });
  });
});

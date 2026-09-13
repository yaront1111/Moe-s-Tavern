// Tests for the dependency auto-unblock module: the event-driven hook on
// DONE/ARCHIVED transitions, the sweep backstop that repairs UNASSIGNED rows,
// the resource-row exclusion, and the dep-less stale-block governor alert.

import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';
import { archiveTaskTool } from '../tools/archiveTask.js';
import {
  DEPENDENCY_WAIT_ALERT_MULTIPLIER,
  alertStaleBlocks,
  dependencyShortfall,
  findDependencyPath,
  formatDependencyCycle,
  isDependencySatisfied,
  runDependencyUnblock,
  unmetBlockedOnTaskIds,
  unmetDependsOn,
} from './dependencyUnblock.js';
import { runBlockedTimeoutSweep } from './sweeps.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { McpAdapter, type JsonRpcResponse } from '../server/McpAdapter.js';
import { recordCheckRun } from './checkRunStore.js';
import { isClaimGatedByDependsOn } from '../util/claimEligibility.js';
import { MoeError } from '../util/errors.js';
import type { CheckRun, Task } from '../types/schema.js';

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

// =============================================================================
// Delivery evidence on a DONE prerequisite (acceptance criterion 2)
// =============================================================================
//
// Under a strict settings.deliveryPolicy, DONE alone no longer releases a
// dependent: the prerequisite must also carry the evidence delivery/policy.ts
// requires of it. The rule lives in isDependencySatisfied, so the claim gate,
// the wait_for_task matcher and the blockedOnTaskIds auto-unblock read one
// answer. Each decoy check record has its own case, so a regression names the
// lookup that broke instead of failing one opaque scenario.
describe('dependencyUnblock — delivery evidence on a DONE prerequisite', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const GATE = 'node gate.cjs';
  const TREE_CURRENT = 'c3'.repeat(20);
  const TREE_OLD = 'd4'.repeat(20);
  /** The harness project plus a gate the wrapper runs on every task. No deliveryPolicy, so the default applies. */
  const DEFAULT_POLICY_SETTINGS = {
    approvalMode: 'CONTROL',
    speedModeDelayMs: 2000,
    autoCreateBranch: true,
    branchPattern: 'moe/{epicId}/{taskId}',
    commitPattern: 'feat({epicId}): {taskTitle}',
    agentCommand: 'claude',
    autoCommit: true,
    qualityGate: GATE,
    qualityGateScope: 'everyTask',
  };
  const STRICT_SETTINGS = { ...DEFAULT_POLICY_SETTINGS, deliveryPolicy: 'local-branch' };

  /** A stored CheckRun on task-P's current candidate; each decoy overrides what makes it wrong. */
  const run = (id: string, overrides: Partial<CheckRun> = {}): CheckRun => ({
    id,
    candidateId: 'cand-P-current',
    treeSha: TREE_CURRENT,
    command: GATE,
    exitCode: 0,
    outputTail: 'gate ok',
    runnerId: 'runner-pilot',
    source: 'runner-observed',
    ...overrides,
  });
  const RUNNER_PASS = run('check-P-current-runner-pass');
  const FAILED_RUN = run('check-P-current-fail', { exitCode: 1, outputTail: 'gate failed' });
  const OLD_CANDIDATE_PASS = run('check-P-old-pass', { candidateId: 'cand-P-old', treeSha: TREE_OLD });
  const OTHER_TREE_PASS = run('check-P-current-other-tree-pass', { treeSha: TREE_OLD });
  const OTHER_COMMAND_PASS = run('check-P-current-other-command-pass', { command: 'node lint.cjs', outputTail: 'lint ok' });
  const AGENT_REPORTED_PASS = run('check-P-current-agent-pass', { source: 'agent-reported' });
  const FAILED_RUN_AND_DECOYS = [FAILED_RUN, OLD_CANDIDATE_PASS, OTHER_TREE_PASS, OTHER_COMMAND_PASS, AGENT_REPORTED_PASS];

  interface Fixture {
    settings?: Record<string, unknown>;
    prerequisite?: Partial<Task>;
    /** false: task-P has no candidate at all. */
    candidates?: boolean;
    checks?: CheckRun[];
    tasks?: Array<Partial<Task>>;
  }

  function writeRecord(kind: string, record: { id: string }): void {
    const dir = path.join(h.moePath, kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }

  /**
   * task-P (DONE unless overridden) with a current and an older candidate;
   * task-D waits on it through dependsOn and task-E through a BLOCKED hold.
   * Records are written before load(), exactly like acceptance criterion 2.
   */
  async function seed(fixture: Fixture = {}): Promise<void> {
    h.setupMoeFolder({ settings: (fixture.settings ?? STRICT_SETTINGS) as never });
    h.createEpic();
    if (fixture.candidates !== false) {
      const candidate = (id: string, treeSha: string, createdAt: string) => ({
        id,
        attemptId: 'attempt-P-1',
        taskId: 'task-P',
        baseRevision: 'a1'.repeat(20),
        treeSha,
        deliveryTarget: 'refs/heads/wave1-pilot',
        createdAt,
      });
      writeRecord('candidates', candidate('cand-P-current', TREE_CURRENT, '2026-09-11T02:00:00.000Z'));
      writeRecord('candidates', candidate('cand-P-old', TREE_OLD, '2026-09-11T01:00:00.000Z'));
    }
    for (const check of fixture.checks ?? []) writeRecord('checks', check);
    h.createTask({ id: 'task-P', status: 'DONE', order: 1, ...fixture.prerequisite });
    h.createTask({ id: 'task-D', status: 'WORKING', order: 2, dependsOn: ['task-P'] });
    h.createTask({
      id: 'task-E',
      status: 'BLOCKED',
      order: 3,
      blockedOnTaskIds: ['task-P'],
      blockedFromStatus: 'WORKING',
      blockedReason: 'Waiting on task-P to land.',
      blockedAt: '2026-09-11T00:00:00.000Z',
    });
    for (const task of fixture.tasks ?? []) h.createTask(task);
    await h.state.load();
  }

  const row = (id: string): Task => h.state.getTask(id)!;

  const claim = (args: Record<string, unknown>): Promise<unknown> =>
    claimNextTaskTool(h.state).handler({ statuses: ['WORKING'], workerId: 'worker-N', ...args }, h.state);

  /** The MoeError a call must be refused with; a call that resolves fails the case here. */
  async function refusalOf(call: Promise<unknown>): Promise<MoeError> {
    try {
      await call;
    } catch (err) {
      if (err instanceof MoeError) return err;
      throw err;
    }
    throw new Error('expected a MoeError refusal, but the call resolved');
  }

  describe('the evidence rule', () => {
    it.each<[string, Fixture]>([
      ['no candidate and no check run at all', { candidates: false }],
      ['a failed gate run and every decoy', { checks: FAILED_RUN_AND_DECOYS }],
    ])('under the default policy a DONE prerequisite with %s still releases its dependents', async (_label, fixture) => {
      await seed({ ...fixture, settings: DEFAULT_POLICY_SETTINGS });

      expect(isDependencySatisfied(h.state, 'task-P')).toBe(true);
      expect(unmetDependsOn(h.state, row('task-D'))).toEqual([]);
      expect(await runDependencyUnblock(h.state, 'task-P')).toEqual(['task-E']);
    });

    it.each<[string, CheckRun]>([
      ['a failed gate run on the current candidate', FAILED_RUN],
      ['a pass for an older candidate of the same task', OLD_CANDIDATE_PASS],
      ['a pass naming the current candidate on a tree it does not have', OTHER_TREE_PASS],
      ['a pass of a command that is not the required gate', OTHER_COMMAND_PASS],
      ['an agent-reported pass on the right candidate, tree and command', AGENT_REPORTED_PASS],
    ])('under the strict policy %s does not release the dependents', async (_label, decoy) => {
      await seed({ checks: [decoy] });

      expect(isDependencySatisfied(h.state, 'task-P')).toBe(false);
      expect(unmetDependsOn(h.state, row('task-D'))).toEqual(['task-P']);
      expect(unmetBlockedOnTaskIds(h.state, row('task-E'))).toEqual(['task-P']);
    });

    it('a runner-observed exit-0 gate run on the current candidate and its own tree releases the dependents', async () => {
      await seed({ checks: [...FAILED_RUN_AND_DECOYS, RUNNER_PASS] });

      expect(isDependencySatisfied(h.state, 'task-P')).toBe(true);
      expect(unmetDependsOn(h.state, row('task-D'))).toEqual([]);
      expect(unmetBlockedOnTaskIds(h.state, row('task-E'))).toEqual([]);
    });

    it('reports the shortfall as the exact token array acceptance criterion 2 asserts', async () => {
      await seed({ checks: FAILED_RUN_AND_DECOYS });

      expect(dependencyShortfall(h.state, 'task-P')).toEqual({
        satisfied: false,
        missingEvidence: ['required-check:node gate.cjs'],
      });
    });

    it('a DONE prerequisite with no candidate at all is withheld and reports the missing check rather than throwing', async () => {
      await seed({ candidates: false });

      expect(isDependencySatisfied(h.state, 'task-P')).toBe(false);
      expect(dependencyShortfall(h.state, 'task-P')).toEqual({
        satisfied: false,
        missingEvidence: ['required-check:node gate.cjs'],
      });
    });

    it('a prerequisite id missing from the board still counts as satisfied under the strict policy', async () => {
      await seed({ checks: FAILED_RUN_AND_DECOYS, tasks: [{ id: 'task-G', status: 'WORKING', order: 4, dependsOn: ['task-gone'] }] });

      expect(isDependencySatisfied(h.state, 'task-gone')).toBe(true);
      expect(unmetDependsOn(h.state, row('task-G'))).toEqual([]);
      expect(dependencyShortfall(h.state, 'task-gone')).toEqual({ satisfied: true, missingEvidence: [] });
    });

    it.each(['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'BLOCKED'] as const)(
      'a %s prerequisite is unmet on status alone: no evidence is asked for, and a matching pass does not stand in for DONE',
      async (status) => {
        await seed({ prerequisite: { status }, checks: [RUNNER_PASS] });

        expect(isDependencySatisfied(h.state, 'task-P')).toBe(false);
        expect(dependencyShortfall(h.state, 'task-P')).toEqual({ satisfied: false, missingEvidence: [] });
      }
    );

    it('an ARCHIVED prerequisite still counts as satisfied: archiving is allowed from unfinished statuses, so it never claimed delivery', async () => {
      await seed({ prerequisite: { status: 'ARCHIVED' }, checks: FAILED_RUN_AND_DECOYS });

      expect(isDependencySatisfied(h.state, 'task-P')).toBe(true);
      expect(dependencyShortfall(h.state, 'task-P')).toEqual({ satisfied: true, missingEvidence: [] });
    });

    it.each<[string, 'candidates' | 'checkRuns']>([
      ['the candidate lookup', 'candidates'],
      ['the check-run lookup', 'checkRuns'],
    ])('withholds the dependents when %s throws, even with a matching pass on disk', async (_label, map) => {
      await seed({ checks: [RUNNER_PASS] });
      vi.spyOn(h.state[map], 'values').mockImplementation(() => {
        throw new Error('records unreadable');
      });

      expect(isDependencySatisfied(h.state, 'task-P')).toBe(false);
      expect(await runDependencyUnblock(h.state, 'task-P')).toEqual([]);
      expect(row('task-E').status).toBe('BLOCKED');
    });

    it('an unrecognised deliveryPolicy withholds the dependents without the scan throwing', async () => {
      await seed({ settings: { ...STRICT_SETTINGS, deliveryPolicy: 'local-brnach' }, checks: [RUNNER_PASS] });

      expect(isDependencySatisfied(h.state, 'task-P')).toBe(false);
      expect(await runDependencyUnblock(h.state, 'task-P')).toEqual([]);
      expect(row('task-E').status).toBe('BLOCKED');
      expect(() => dependencyShortfall(h.state, 'task-P')).toThrow('Invalid deliveryPolicy');
    });

    it('cycle detection ignores delivery evidence: edges out of a DONE prerequisite stay dead while it withholds dependents', async () => {
      await seed({ checks: FAILED_RUN_AND_DECOYS, prerequisite: { dependsOn: ['task-D'] } });

      expect(isDependencySatisfied(h.state, 'task-P')).toBe(false);
      expect(findDependencyPath(h.state, 'task-P', 'task-D')).toBeNull();
    });
  });

  describe('the claim gate', () => {
    it('refuses an explicit claim behind a DONE prerequisite lacking evidence with DEPENDENCY_EVIDENCE_MISSING, before any write', async () => {
      await seed({ checks: FAILED_RUN_AND_DECOYS });
      const taskFile = path.join(h.moePath, 'tasks', 'task-D.json');
      const before = fs.readFileSync(taskFile, 'utf8');
      const updateTask = vi.spyOn(h.state, 'updateTask');
      const createWorker = vi.spyOn(h.state, 'createWorker');

      const err = await refusalOf(claim({ taskId: 'task-D' }));

      expect({ code: err.code, codeName: err.codeName, context: err.context }).toEqual({
        code: -32003,
        codeName: 'DEPENDENCY_EVIDENCE_MISSING',
        context: { taskId: 'task-D', prerequisiteTaskId: 'task-P', missingEvidence: ['required-check:node gate.cjs'] },
      });
      expect(err.message).toBe(
        '[DEPENDENCY_EVIDENCE_MISSING] Task task-D cannot be claimed yet: its prerequisite task-P is DONE but lacks the ' +
          'delivery evidence settings.deliveryPolicy requires: required-check:node gate.cjs (no runner-observed exit-0 run ' +
          'of "node gate.cjs" is recorded for the current candidate\'s tree). dependsOn withholds WORKING claims until that ' +
          'evidence is recorded; an architect/governor can edit the dependencies with moe.set_task_dependencies.'
      );
      expect(updateTask).not.toHaveBeenCalled();
      expect(createWorker).not.toHaveBeenCalled();
      expect(fs.readFileSync(taskFile, 'utf8')).toBe(before);
    });

    it('over MCP the refusal keeps its code and codeName, and its message names the prerequisite and the missing evidence', async () => {
      await seed({ checks: FAILED_RUN_AND_DECOYS });

      const wire = (await new McpAdapter(h.state).handle({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'moe.claim_next_task', arguments: { statuses: ['WORKING'], taskId: 'task-D', workerId: 'worker-N' } },
      })) as JsonRpcResponse;

      expect(wire.error).toEqual({
        code: -32003,
        message: expect.stringContaining(
          'its prerequisite task-P is DONE but lacks the delivery evidence settings.deliveryPolicy requires: required-check:node gate.cjs'
        ),
        data: { tool: 'moe.claim_next_task', codeName: 'DEPENDENCY_EVIDENCE_MISSING' },
      });
    });

    it('keeps today\'s refusal word for word when a prerequisite is unmet on status, with no evidence claim', async () => {
      await seed({ prerequisite: { status: 'REVIEW' } });

      const err = await refusalOf(claim({ taskId: 'task-D' }));

      expect({ code: err.code, codeName: err.codeName }).toEqual({ code: -32003, codeName: 'NOT_ALLOWED' });
      expect(err.message).toBe(
        '[NOT_ALLOWED] claim not allowed: Task task-D has unmet dependencies: task-P (dependsOn gates WORKING claims until ' +
          'they are DONE/ARCHIVED). An architect/governor can edit them with moe.set_task_dependencies.'
      );
    });

    it('names only the unfinished prerequisite when another one lacks evidence: the status refusal comes first', async () => {
      await seed({
        checks: FAILED_RUN_AND_DECOYS,
        tasks: [
          { id: 'task-R', status: 'REVIEW', order: 4 },
          { id: 'task-M', status: 'WORKING', order: 5, dependsOn: ['task-P', 'task-R'] },
        ],
      });

      const err = await refusalOf(claim({ taskId: 'task-M' }));

      expect(err.codeName).toBe('NOT_ALLOWED');
      expect(err.message).toBe(
        '[NOT_ALLOWED] claim not allowed: Task task-M has unmet dependencies: task-R (dependsOn gates WORKING claims until ' +
          'they are DONE/ARCHIVED). An architect/governor can edit them with moe.set_task_dependencies.'
      );
    });

    it('refuses an explicit claim with INVALID_INPUT naming the setting when deliveryPolicy is unrecognised', async () => {
      await seed({ settings: { ...STRICT_SETTINGS, deliveryPolicy: 'local-brnach' }, checks: [RUNNER_PASS] });

      const err = await refusalOf(claim({ taskId: 'task-D' }));

      expect({ code: err.code, codeName: err.codeName }).toEqual({ code: -32602, codeName: 'INVALID_INPUT' });
      expect(err.message).toBe(
        '[INVALID_INPUT] Invalid deliveryPolicy: must be one of legacy, local-branch, remote-push, merged-pull-request, ' +
          'manual-artifact (got "local-brnach")'
      );
      expect(row('task-D').assignedWorkerId).toBeNull();
    });

    it('the ranked claim and the wait_for_task matcher both skip a dependent withheld on evidence', async () => {
      await seed({ checks: FAILED_RUN_AND_DECOYS, tasks: [{ id: 'task-O', status: 'WORKING', order: 9 }] });

      expect(isClaimGatedByDependsOn(h.state, row('task-D'))).toBe(true);
      const result = (await claim({})) as { hasNext: boolean; task: { id: string } };

      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-O');
      expect(row('task-D').assignedWorkerId).toBeNull();
    });

    it('planning a dependent still proceeds while its DONE prerequisite lacks evidence', async () => {
      await seed({ checks: FAILED_RUN_AND_DECOYS, tasks: [{ id: 'task-Q', status: 'PLANNING', order: 4, dependsOn: ['task-P'] }] });

      const result = (await claim({ statuses: ['PLANNING'], taskId: 'task-Q', workerId: 'architect-N' })) as {
        hasNext: boolean;
        task: { id: string };
      };

      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-Q');
      expect(row('task-Q').assignedWorkerId).toBe('architect-N');
    });
  });

  describe('the blockedOnTaskIds auto-unblock', () => {
    it('holds task-E byte for byte while the evidence is missing and restores it once a runner-observed pass is recorded', async () => {
      await seed({ checks: FAILED_RUN_AND_DECOYS });
      const taskFile = path.join(h.moePath, 'tasks', 'task-E.json');
      const before = fs.readFileSync(taskFile, 'utf8');

      expect(await runDependencyUnblock(h.state, 'task-P')).toEqual([]);
      expect(fs.readFileSync(taskFile, 'utf8')).toBe(before);

      await recordCheckRun(h.state, RUNNER_PASS);

      expect(await runDependencyUnblock(h.state, 'task-P')).toEqual(['task-E']);
      expect(row('task-E').status).toBe('WORKING');
    });

    it('does not release task-E through the updateTask hook when the prerequisite lands DONE without evidence', async () => {
      await seed({ prerequisite: { status: 'REVIEW' }, checks: FAILED_RUN_AND_DECOYS });

      await h.state.updateTask('task-P', { status: 'DONE' });

      expect(row('task-E').status).toBe('BLOCKED');
      expect(row('task-E').blockedOnTaskIds).toEqual(['task-P']);
    });
  });
});

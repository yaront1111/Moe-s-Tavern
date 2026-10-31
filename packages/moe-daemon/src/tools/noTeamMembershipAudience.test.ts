import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimNextTaskTool } from './claimNextTask.js';
import { waitForTaskTool } from './waitForTask.js';
import { getTools, toolsForRole } from './index.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { noTeamMembershipRefusal } from '../util/teamMembershipHeal.js';
import type { TeamRole } from '../types/schema.js';

/**
 * A NO_TEAM_MEMBERSHIP refusal is only a remedy if the caller can execute it.
 * TOOL_AUDIENCE hides moe.join_team and moe.list_teams from architect, worker
 * and qa seats, so a refusal that names them leaves the seat nothing to do.
 */
type Seat = { role: TeamRole; status: 'PLANNING' | 'WORKING' | 'REVIEW' };
const SEATS: readonly Seat[] = [
  { role: 'architect', status: 'PLANNING' },
  { role: 'worker', status: 'WORKING' },
  { role: 'qa', status: 'REVIEW' }
];

describe('NO_TEAM_MEMBERSHIP names only tools the caller can see', () => {
  const h = new ToolTestHarness();

  beforeEach(() => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
  });

  afterEach(() => {
    h.cleanup();
  });

  /** Every distinct `moe.<name>` token anywhere in the reply: nextAction.tool, its args and all prose. */
  function namedTools(reply: unknown): string[] {
    return [...new Set(JSON.stringify(reply).match(/moe\.[a-z_]+/g) ?? [])];
  }

  /** What the caller's tools/list shows. */
  function visible(role: TeamRole | null): string[] {
    return toolsForRole(getTools(h.state), role).map((t) => t.name);
  }

  /** The exact board that arms the solo epic+status rule: a live peer holds the column, a free row sits behind it. */
  async function armSoloBlockedBoard(role: string, status: string): Promise<string> {
    h.createTask({ id: 'task-free', status: status as never, order: 1 });
    h.createTask({ id: 'task-peer', status: status as never, order: 2, assignedWorkerId: `${role}-peer` });
    h.createWorker({ id: `${role}-peer`, currentTaskId: 'task-peer', status: 'CODING' });
    h.createWorker({ id: `${role}-solo` });
    await h.state.load();
    return `${role}-solo`;
  }

  /** The assertions a seat's refusal must meet, whichever tool produced it. */
  function expectSeatHandoff(reply: Record<string, unknown>, role: TeamRole, workerId: string): void {
    expect(reply.hasNext).toBe(false);
    expect(reply.code).toBe('NO_TEAM_MEMBERSHIP');
    expect(reply.nextAction).toBeUndefined();
    expect(reply.sessionHandoff).toEqual({
      action: 'END_SESSION',
      workerId,
      reason: expect.stringContaining(workerId)
    });
    // The DoD-1 assertion: nothing named is missing from the caller's tools/list.
    const seen = visible(role);
    expect(namedTools(reply).filter((t) => !seen.includes(t))).toEqual([]);
    // This is the team-membership answer, not the concurrent-claim one.
    expect(JSON.stringify(reply)).not.toContain('taken by concurrent workers');
  }

  describe.each(SEATS)('$role seat', ({ role, status }) => {
    it('has a tools/list that hides the join_team remedy (premise, so the cases below cannot pass vacuously)', () => {
      expect(visible(role)).not.toContain('moe.join_team');
      expect(visible(role)).not.toContain('moe.list_teams');
    });

    it('claim_next_task: ends the session instead of naming a tool the seat cannot see', async () => {
      const workerId = await armSoloBlockedBoard(role, status);

      const reply = await claimNextTaskTool(h.state).handler(
        { workerId, statuses: [status] },
        h.state
      ) as Record<string, unknown>;

      expectSeatHandoff(reply, role, workerId);
      // The solo rule still refused, and nothing healed the seat.
      expect(h.state.getTask('task-free')!.assignedWorkerId).toBeNull();
      expect(h.state.getTeamForWorker(workerId)).toBeNull();
    });

    it('wait_for_task (immediate path): answers the same handoff at once and never parks', async () => {
      const workerId = await armSoloBlockedBoard(role, status);

      const reply = await waitForTaskTool(h.state).handler(
        { workerId, statuses: [status], timeoutMs: 1000 },
        h.state
      ) as Record<string, unknown>;

      expectSeatHandoff(reply, role, workerId);
      expect(reply.timedOut).toBeUndefined();
      expect(h.state.getTask('task-free')!.assignedWorkerId).toBeNull();
      expect(h.state.getTeamForWorker(workerId)).toBeNull();
    });

    it('noTeamMembershipRefusal: the pure function gives the handoff variant for this role', () => {
      const workerId = `${role}-x`;
      const refusal = noTeamMembershipRefusal(workerId) as unknown as Record<string, unknown>;

      expect(refusal.hasNext).toBe(false);
      expect(refusal.code).toBe('NO_TEAM_MEMBERSHIP');
      expect(refusal.nextAction).toBeUndefined();
      expect(refusal.sessionHandoff).toEqual({
        action: 'END_SESSION',
        workerId,
        reason: expect.any(String)
      });
    });
  });

  describe.each([
    ['governor-solo', 'governor'],
    ['w-solo', null]
  ] as const)('%s (role %s) keeps the join_team remedy its tools/list shows', (id, role) => {
    it('returns the join_team nextAction, no handoff, and only tools the caller can see', () => {
      const refusal = noTeamMembershipRefusal(id) as unknown as Record<string, unknown>;

      expect(refusal.hasNext).toBe(false);
      expect(refusal.code).toBe('NO_TEAM_MEMBERSHIP');
      const nextAction = refusal.nextAction as { tool: string; args: unknown };
      expect(nextAction.tool).toBe('moe.join_team');
      expect(nextAction.args).toEqual({ workerId: id });
      expect(refusal.sessionHandoff).toBeUndefined();
      const seen = visible(role);
      expect(namedTools(refusal).filter((t) => !seen.includes(t))).toEqual([]);
    });
  });
});

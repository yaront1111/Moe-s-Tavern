import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { releaseTaskTool } from './releaseTask.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { deregisterWorkerTool } from './deregisterWorker.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { currentAttempt, listAttempts, openAttempt } from '../state/attemptStore.js';
import { UNIDENTIFIED_RELEASER } from '../util/claimGuards.js';
import { computeDiskStateSignature } from '../util/diskState.js';
import { MoeError } from '../util/errors.js';
import type {
  Project, Epic, ExecutionAttempt, ExecutionAttemptPhase, HandoffNote, ImplementationStep, Task, Worker,
} from '../types/schema.js';

// The helper shells out to git; these suites only care about the wiring, so the
// module is mocked and the real subprocess is covered in util/diskState.test.ts.
vi.mock('../util/diskState.js', () => ({ computeDiskStateSignature: vi.fn() }));
const mockedSignature = vi.mocked(computeDiskStateSignature);

describe('moe.release_task', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test',
      schemaVersion: 6,
      name: 'Test',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO',
        speedModeDelayMs: 2000,
        autoCreateBranch: false,
        branchPattern: '',
        commitPattern: '',
        agentCommand: 'claude',
        enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  function writeEpic(): Epic {
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
    return epic;
  }

  function writeTask(overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 'Some task', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: 'worker-a', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', task.id + '.json'), JSON.stringify(task, null, 2));
    return task;
  }

  function writeWorker(overrides: Partial<Worker> = {}): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id: 'worker-a', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: 'task-1', status: 'CODING', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', worker.id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-release-task-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    writeEpic();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('clears assignedWorkerId, sets owning worker IDLE, and keeps WORKING claimable in place', async () => {
    writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
    writeWorker({ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING' });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1', reason: 'stuck' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.previousWorkerId).toBe('worker-a');
    // WORKING stays WORKING-unassigned — that is the column workers claim
    // (statuses:["WORKING"]); routing to BACKLOG would strand the task in a
    // human-gated column no agent can pick up.
    expect(result.status).toBe('WORKING');

    const task = state.getTask('task-1')!;
    expect(task.assignedWorkerId).toBeNull();
    expect(task.status).toBe('WORKING');

    const worker = state.getWorker('worker-a')!;
    expect(worker.currentTaskId).toBeNull();
    expect(worker.status).toBe('IDLE');
  });

  it('does not modify a worker whose currentTaskId is a different task', async () => {
    writeTask({ id: 'task-1', assignedWorkerId: 'worker-a', status: 'WORKING' });
    // worker is recorded as working a different task
    writeWorker({ id: 'worker-a', currentTaskId: 'task-other', status: 'CODING' });
    await state.load();

    const tool = releaseTaskTool(state);
    await tool.handler({ taskId: 'task-1' }, state);

    const worker = state.getWorker('worker-a')!;
    expect(worker.currentTaskId).toBe('task-other');
    expect(worker.status).toBe('CODING');

    const task = state.getTask('task-1')!;
    expect(task.assignedWorkerId).toBeNull();
  });

  it('is a no-op success when task is already unassigned', async () => {
    writeTask({ assignedWorkerId: null, status: 'PLANNING' });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.previousWorkerId).toBeNull();
    expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
  });

  it('leaves a WORKING-but-unassigned task in place (already claimable) and routes all-steps-done to REVIEW', async () => {
    // WORKING-unassigned is the state workers claim from — no repair needed.
    writeTask({ assignedWorkerId: null, status: 'WORKING' });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('WORKING');
    expect(state.getTask('task-1')!.status).toBe('WORKING');

    // The one repair that still applies: every step COMPLETED → hand to QA
    // instead of letting a worker re-claim a task with nothing left to do.
    writeTask({
      id: 'task-all-done',
      assignedWorkerId: null,
      status: 'WORKING',
      implementationPlan: [
        { stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: [] },
      ],
    });
    await state.load();
    const repaired = await tool.handler({ taskId: 'task-all-done' }, state) as Record<string, unknown>;
    expect(repaired.success).toBe(true);
    expect(repaired.status).toBe('REVIEW');
    expect(state.getTask('task-all-done')!.status).toBe('REVIEW');
  });

  it('is a strict no-op on an unassigned DONE task (must NOT resurrect it to BACKLOG)', async () => {
    // Every normally-finished task is DONE+unassigned (status changes auto-clear
    // the assignee), so a duplicate/late release_task must not "repair" it.
    writeTask({ assignedWorkerId: null, status: 'DONE' });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({
      taskId: 'task-1',
      handoffNote: { whatIsDone: 'everything', whatRemains: 'nothing' },
    }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('DONE');
    expect(result.warning).toMatch(/ignored/);

    const task = state.getTask('task-1')!;
    expect(task.status).toBe('DONE');
    expect(task.priorHandoffs ?? []).toHaveLength(0);
  });

  it('is a strict no-op on an unassigned ARCHIVED task', async () => {
    writeTask({ assignedWorkerId: null, status: 'ARCHIVED' });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('ARCHIVED');
    expect(state.getTask('task-1')!.status).toBe('ARCHIVED');
  });

  it('clears needsHumanReview on a parked REVIEW task (documented human unpark path)', async () => {
    writeTask({ assignedWorkerId: null, status: 'REVIEW', needsHumanReview: true });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1', reason: 'human unpark' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.unparked).toBe(true);

    const task = state.getTask('task-1')!;
    expect(task.status).toBe('REVIEW');
    expect(task.needsHumanReview).toBe(false);
  });

  it('persists handoffNote even when the task is already unassigned, instead of discarding it', async () => {
    writeTask({ assignedWorkerId: null, status: 'WORKING' });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({
      taskId: 'task-1',
      workerId: 'worker-recovering',
      handoffNote: {
        whatIsDone: 'wired the new endpoint',
        whatRemains: 'add tests',
      },
    }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.priorHandoffCount).toBe(1);

    const task = state.getTask('task-1')!;
    expect(task.status).toBe('WORKING');
    expect(task.priorHandoffs).toHaveLength(1);
    expect(task.priorHandoffs![0].whatIsDone).toBe('wired the new endpoint');
    expect(task.priorHandoffs![0].releasedBy).toBe('worker-recovering');
  });

  it('throws notFound for unknown taskId', async () => {
    await state.load();
    const tool = releaseTaskTool(state);
    await expect(tool.handler({ taskId: 'task-nope' }, state))
      .rejects.toThrow(/not found|NOT_FOUND/i);
  });

  it('throws missingRequired when taskId is omitted', async () => {
    await state.load();
    const tool = releaseTaskTool(state);
    await expect(tool.handler({}, state)).rejects.toThrow(/taskId/);
  });

  describe('disk-state capture', () => {
    const SIGNATURE = 'v1:9f2c0a1b3d4e5f60718293a4b5c6d7e8f9012345:3:0a1b2c3d4e5f';

    beforeEach(() => {
      mockedSignature.mockReset();
      mockedSignature.mockResolvedValue(SIGNATURE);
    });

    it('stores the signature on the handoff note and reports the capture', async () => {
      writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
      writeWorker({ id: 'worker-a', currentTaskId: 'task-1' });
      await state.load();

      const tool = releaseTaskTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        workerId: 'worker-a',
        handoffNote: { whatIsDone: 'half the wiring', whatRemains: 'the tests' },
      }, state) as Record<string, unknown>;

      expect(result.diskStateCaptured).toBe(true);
      expect(mockedSignature).toHaveBeenCalledTimes(1);
      expect(mockedSignature).toHaveBeenCalledWith(testDir);
      expect(state.getTask('task-1')!.priorHandoffs![0].diskState).toBe(SIGNATURE);
    });

    it('leaves diskState absent when the capture fails (never a sentinel)', async () => {
      mockedSignature.mockResolvedValue(undefined);
      writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
      writeWorker({ id: 'worker-a', currentTaskId: 'task-1' });
      await state.load();

      const tool = releaseTaskTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        workerId: 'worker-a',
        handoffNote: { whatIsDone: 'half the wiring', whatRemains: 'the tests' },
      }, state) as Record<string, unknown>;

      expect(result.diskStateCaptured).toBeUndefined();
      const note = state.getTask('task-1')!.priorHandoffs![0];
      expect(note.whatIsDone).toBe('half the wiring');
      expect('diskState' in note).toBe(false);
    });

    it('still releases when the capture throws', async () => {
      mockedSignature.mockRejectedValue(new Error('git exploded'));
      writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
      writeWorker({ id: 'worker-a', currentTaskId: 'task-1' });
      await state.load();

      const tool = releaseTaskTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        workerId: 'worker-a',
        handoffNote: { whatIsDone: 'half the wiring', whatRemains: 'the tests' },
      }, state) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.diskStateCaptured).toBeUndefined();
      const note = state.getTask('task-1')!.priorHandoffs![0];
      expect('diskState' in note).toBe(false);
      expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
    });

    it('never shells out to git when the release carries no handoffNote', async () => {
      writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
      writeWorker({ id: 'worker-a', currentTaskId: 'task-1' });
      await state.load();

      const tool = releaseTaskTool(state);
      const result = await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state) as Record<string, unknown>;

      expect(result.diskStateCaptured).toBeUndefined();
      expect(mockedSignature).toHaveBeenCalledTimes(0);
    });

    it('stores the signature on the unassigned-repair path too', async () => {
      writeTask({ assignedWorkerId: null, status: 'WORKING' });
      await state.load();

      const tool = releaseTaskTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        workerId: 'worker-recovering',
        handoffNote: { whatIsDone: 'wired the new endpoint', whatRemains: 'add tests' },
      }, state) as Record<string, unknown>;

      expect(result.previousWorkerId).toBeNull();
      expect(result.diskStateCaptured).toBe(true);
      expect(state.getTask('task-1')!.priorHandoffs![0].diskState).toBe(SIGNATURE);
    });
  });

  describe('refusal cascade → BACKLOG', () => {
    const NOW = '2026-07-31T12:00:00.000Z';
    const NOW_MS = Date.parse(NOW);
    const HOUR_MS = 60 * 60 * 1000;

    // Only Date is faked: the handler awaits real fs writes, and faking timers
    // wholesale would stall them.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW_MS);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Newest-first `priorHandoffs` entry that qualifies as empty progress. */
    function refusal(hoursAgo: number, overrides: Partial<HandoffNote> = {}): HandoffNote {
      return {
        whatIsDone: 'nothing',
        whatRemains: 'the whole task',
        releasedBy: `worker-${hoursAgo}h`,
        releasedAt: new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString(),
        ...overrides,
      };
    }

    function progress(hoursAgo: number): HandoffNote {
      return refusal(hoursAgo, { whatIsDone: 'wired the parser and added two tests' });
    }

    function patchSettings(extra: Record<string, unknown>): void {
      const file = path.join(moePath, 'project.json');
      const project = JSON.parse(fs.readFileSync(file, 'utf8')) as Project;
      project.settings = { ...project.settings, ...extra } as Project['settings'];
      fs.writeFileSync(file, JSON.stringify(project, null, 2));
    }

    /** Third empty-progress release: two seeded refusals + this one. */
    async function releaseWith(
      handoffNote: Record<string, string> | undefined,
      priorHandoffs: HandoffNote[]
    ): Promise<Record<string, unknown>> {
      writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING', priorHandoffs });
      writeWorker({ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING' });
      await state.load();
      const tool = releaseTaskTool(state);
      return await tool.handler({
        taskId: 'task-1',
        workerId: 'worker-a',
        ...(handoffNote ? { handoffNote } : {}),
      }, state) as Record<string, unknown>;
    }

    const EMPTY_NOTE = { whatIsDone: 'nothing — could not start', whatRemains: 'everything' };

    it('parks to BACKLOG on the third empty-progress release inside 24h', async () => {
      const posts = vi.spyOn(state, 'postToRoleChannel');
      const result = await releaseWith(EMPTY_NOTE, [refusal(2), refusal(20)]);

      expect(result.status).toBe('BACKLOG');
      expect(result.cascadeTriggered).toBe(true);
      expect(result.previousWorkerId).toBe('worker-a');

      const task = state.getTask('task-1')!;
      expect(task.status).toBe('BACKLOG');
      expect(task.assignedWorkerId).toBeNull();
      // History is preserved newest-first, not consumed by the cascade.
      expect(task.priorHandoffs).toHaveLength(3);
      expect(task.priorHandoffs!.map(h => h.releasedBy)).toEqual(['worker-a', 'worker-2h', 'worker-20h']);
      // QA-owned counters stay out of it.
      expect(task.reopenCount).toBe(0);
      expect(task.reopenReason).toBeNull();

      // The worker is still idled — a park must not strand it as CODING.
      const worker = state.getWorker('worker-a')!;
      expect(worker.currentTaskId).toBeNull();
      expect(worker.status).toBe('IDLE');

      const cascadeMsg = posts.mock.calls.find(
        ([channel, content]) => channel === 'governors' && content.includes('BACKLOG')
      );
      expect(cascadeMsg).toBeDefined();
      expect(cascadeMsg![1]).toContain('task-1');
      expect(cascadeMsg![1]).toMatch(/3 empty-progress releases in 24h/);
      expect(cascadeMsg![1]).toMatch(/human/i);
    });

    it('counts a refusal released exactly 24h ago (inclusive window)', async () => {
      const result = await releaseWith(EMPTY_NOTE, [refusal(1), refusal(24)]);
      expect(result.status).toBe('BACKLOG');
      expect(result.cascadeTriggered).toBe(true);
    });

    it('ignores a refusal released just outside the 24h window', async () => {
      const stale = refusal(0, { releasedAt: new Date(NOW_MS - 24 * HOUR_MS - 1).toISOString() });
      const result = await releaseWith(EMPTY_NOTE, [refusal(1), stale]);
      expect(result.status).toBe('WORKING');
      expect(result.cascadeTriggered).toBeUndefined();
      expect(state.getTask('task-1')!.status).toBe('WORKING');
    });

    it('ignores malformed and future releasedAt timestamps', async () => {
      const malformed = refusal(0, { releasedAt: 'not-a-date' });
      const future = refusal(-1); // one hour ahead of the release
      const result = await releaseWith(EMPTY_NOTE, [malformed, future, refusal(3)]);
      // Only refusal(3) + the current one qualify → below threshold.
      expect(result.status).toBe('WORKING');
      expect(result.cascadeTriggered).toBeUndefined();
    });

    it('does not count a release whose handoff reports concrete work', async () => {
      const result = await releaseWith(
        { whatIsDone: 'wired the cascade classifier', whatRemains: 'docs' },
        [refusal(1), refusal(2)]
      );
      expect(result.status).toBe('WORKING');
      expect(result.cascadeTriggered).toBeUndefined();
      expect(state.getTask('task-1')!.priorHandoffs).toHaveLength(3);
    });

    it('does not count prior handoffs that report concrete work', async () => {
      const result = await releaseWith(EMPTY_NOTE, [progress(1), progress(2)]);
      expect(result.status).toBe('WORKING');
      expect(result.cascadeTriggered).toBeUndefined();
    });

    it('leaves the second empty-progress release routed normally', async () => {
      const result = await releaseWith(EMPTY_NOTE, [refusal(1)]);
      expect(result.status).toBe('WORKING');
      expect(result.cascadeTriggered).toBeUndefined();
    });

    it('never counts a release that carries no handoff (progress unknown)', async () => {
      const result = await releaseWith(undefined, [refusal(1), refusal(2)]);
      expect(result.status).toBe('WORKING');
      expect(result.cascadeTriggered).toBeUndefined();
      expect(state.getTask('task-1')!.status).toBe('WORKING');
    });

    it('leaves routing to nextStatusForRelease when refusalCascadeAutoBacklog is false', async () => {
      patchSettings({ refusalCascadeAutoBacklog: false });
      const result = await releaseWith(EMPTY_NOTE, [refusal(1), refusal(2)]);
      expect(result.status).toBe('WORKING');
      expect(result.cascadeTriggered).toBeUndefined();
      expect(state.getTask('task-1')!.status).toBe('WORKING');
    });

    it('keeps parking when the setting is explicitly true', async () => {
      patchSettings({ refusalCascadeAutoBacklog: true });
      const result = await releaseWith(EMPTY_NOTE, [refusal(1), refusal(2)]);
      expect(result.status).toBe('BACKLOG');
      expect(result.cascadeTriggered).toBe(true);
    });

    it('never parks an already-unassigned release (no assignee to refuse)', async () => {
      writeTask({
        assignedWorkerId: null,
        status: 'WORKING',
        priorHandoffs: [refusal(1), refusal(2)],
      });
      await state.load();

      const tool = releaseTaskTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        workerId: 'worker-recovering',
        handoffNote: EMPTY_NOTE,
      }, state) as Record<string, unknown>;

      expect(result.status).toBe('WORKING');
      expect(result.cascadeTriggered).toBeUndefined();
      expect(state.getTask('task-1')!.status).toBe('WORKING');
    });

    it('never parks a terminal task carrying a stale assignee', async () => {
      writeTask({
        assignedWorkerId: 'worker-a',
        status: 'DONE',
        priorHandoffs: [refusal(1), refusal(2)],
      });
      writeWorker({ id: 'worker-a', currentTaskId: 'task-1' });
      await state.load();

      const tool = releaseTaskTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        workerId: 'worker-a',
        handoffNote: EMPTY_NOTE,
      }, state) as Record<string, unknown>;

      expect(result.status).toBe('DONE');
      expect(result.cascadeTriggered).toBeUndefined();
      expect(state.getTask('task-1')!.status).toBe('DONE');
    });

    describe('refusalCascadeAutoBacklog validation', () => {
      it('persists an explicit false through updateSettings', async () => {
        await state.load();
        const project = await state.updateSettings({ refusalCascadeAutoBacklog: false });
        expect(project.settings.refusalCascadeAutoBacklog).toBe(false);

        const onDisk = JSON.parse(fs.readFileSync(path.join(moePath, 'project.json'), 'utf8')) as Project;
        expect(onDisk.settings.refusalCascadeAutoBacklog).toBe(false);
      });

      it('rejects a non-boolean without partially applying the update', async () => {
        await state.load();
        await expect(
          state.updateSettings({
            agentCommand: 'codex',
            refusalCascadeAutoBacklog: 'yes',
          } as unknown as Partial<Project['settings']>)
        ).rejects.toThrow(/must be a boolean/);

        expect(state.project!.settings.agentCommand).toBe('claude');
        expect(state.project!.settings.refusalCascadeAutoBacklog).toBeUndefined();
      });

      it('defaults to enabled when the key is absent from an old project file', async () => {
        await state.load();
        expect(state.project!.settings.refusalCascadeAutoBacklog).toBeUndefined();

        const result = await releaseWith(EMPTY_NOTE, [refusal(1), refusal(2)]);
        expect(result.status).toBe('BACKLOG');
      });
    });
  });
});

// =============================================================================
// task-6df8a07b: release CAS + honest banner attribution.
//
// Both 2026-08-19 incidents were an architect handoff release landing on a row
// the wrapper had already re-dispatched: release_task cleared whoever happened
// to hold the row, and the banner named the STRIPPED party as the releaser.
// taskStore's optimistic-concurrency guard cannot see this — it is truthy-gated
// on the incoming assignedWorkerId, so a release (null) skips it entirely.
//
// ANTI-TAUTOLOGY (governor note 4): these assertions never pin the incident
// prose and never compare against text produced by the renderer under test.
// They assert structured facts — the refusal's stable codeName and named
// holder, the result's caller/stripped fields, and how many distinct agent ids
// the banner mentions (one actor for a self-release, two for a strip).
// =============================================================================
describe('moe.release_task — caller attribution and CAS (task-6df8a07b)', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  /** Every agent id the banner mentions, deduped. One id = one actor. */
  function agentIdsIn(message: string): string[] {
    return [...new Set(message.match(/(?:worker|governor|architect)-[a-z0-9]+/g) ?? [])].sort();
  }

  function seedTask(assignedWorkerId: string | null, plan: ImplementationStep[] = []): void {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 'Some task', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: plan,
      status: 'WORKING', assignedWorkerId, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task, null, 2));
  }

  function seedWorker(id: string): void {
    const now = new Date().toISOString();
    const worker: Worker = {
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: 'task-1', status: 'CODING', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
    };
    fs.writeFileSync(path.join(moePath, 'workers', id + '.json'), JSON.stringify(worker, null, 2));
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-release-cas-'));
    moePath = path.join(testDir, '.moe');
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, null, 2));
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify({
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, null, 2));
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // (a) NEGATIVE CONTROL. A silent no-op would satisfy "caller must be the
  // assignee" on paper; this fails unless the call actually REFUSES, by stable
  // codeName, naming the live holder.
  it('refuses a non-assignee release with RELEASE_NOT_ASSIGNEE naming the live holder', async () => {
    seedTask('worker-a');
    seedWorker('worker-a');
    await state.load();

    const tool = releaseTaskTool(state);
    let thrown: unknown;
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'governor-1' }, state);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { codeName?: string; context?: Record<string, unknown> };
    expect(error.codeName).toBe('RELEASE_NOT_ASSIGNEE');
    expect(error.context?.holder).toBe('worker-a');
    expect(error.context?.caller).toBe('governor-1');
    // The refusal must leave the row untouched — a refusal that already mutated
    // is the strip it was written to prevent.
    expect(state.getTask('task-1')!.assignedWorkerId).toBe('worker-a');
  });

  // (b) The legitimate case stays legitimate.
  it('allows a self-release by the current assignee', async () => {
    seedTask('worker-a');
    seedWorker('worker-a');
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.previousWorkerId).toBe('worker-a');
    expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
  });

  // (c) The tool's contract says anyone can call for confirmed-crash recovery.
  // Legacy/TUI/plugin callers supply no workerId and must keep working.
  it('keeps the no-workerId crash-recovery path working', async () => {
    seedTask('worker-a');
    seedWorker('worker-a');
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
  });

  // (d) The single override door, so a row held by a dead worker is still
  // recoverable — and auditable, because the result names both parties.
  it('releases a foreign row with force:true and names both parties', async () => {
    seedTask('worker-a');
    seedWorker('worker-a');
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler(
      { taskId: 'task-1', workerId: 'governor-1', force: true }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.previousWorkerId).toBe('worker-a');
    expect(result.releasedBy).toBe('governor-1');
    expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
  });

  // (e) BANNER, arm 1 — the strip must be legible AS a strip: two distinct
  // agent ids. This is the arm that reproduces the incident.
  it('renders a forced strip with BOTH the caller and the stripped party', async () => {
    seedTask('worker-a');
    seedWorker('worker-a');
    await state.load();
    const posted: string[] = [];
    vi.spyOn(state, 'postToGeneral').mockImplementation(async (content: string) => { posted.push(content); });

    const tool = releaseTaskTool(state);
    await tool.handler({ taskId: 'task-1', workerId: 'governor-1', force: true }, state);

    expect(posted).toHaveLength(1);
    expect(agentIdsIn(posted[0])).toEqual(['governor-1', 'worker-a']);
  });

  // (e) BANNER, arm 2 — the opposite corruption. A fix that renders EVERY
  // release as "X stripped by Y" would turn the legitimate self-release into a
  // false two-actor line, and an assertion written only against arm 1 stays
  // green through it.
  it('renders a genuine self-release as exactly ONE actor', async () => {
    seedTask('worker-a');
    seedWorker('worker-a');
    await state.load();
    const posted: string[] = [];
    vi.spyOn(state, 'postToGeneral').mockImplementation(async (content: string) => { posted.push(content); });

    const tool = releaseTaskTool(state);
    await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state);

    expect(posted).toHaveLength(1);
    expect(agentIdsIn(posted[0])).toEqual(['worker-a']);
    // Two-sided control with arm 3: a fix that stamped the unidentified-caller
    // marker onto EVERY release would leave the id count at one and slip past
    // the assertion above, because the marker is not an agent id.
    expect(posted[0]).not.toContain(UNIDENTIFIED_RELEASER);
  });

  // (e) BANNER, arm 3 — the CALLER-LESS strip. agentIdsIn is blind here by
  // construction (it matches worker|governor|architect ids only, and a caller
  // that supplied no id has none), which is exactly how arms 1 and 2 stayed
  // green over a strip rendered as `worker-a released task`: byte-identical to
  // a self-release, naming the victim as releaser. So this arm asserts the
  // structured roles instead — who released vs who was stripped.
  it('renders a caller-less release of a live holder as a strip, not a self-release', async () => {
    seedTask('worker-a');
    seedWorker('worker-a');
    await state.load();
    const posted: string[] = [];
    vi.spyOn(state, 'postToGeneral').mockImplementation(async (content: string) => { posted.push(content); });

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.previousWorkerId).toBe('worker-a');
    // The victim must not be recorded as the releaser.
    expect(result.releasedBy).not.toBe('worker-a');
    expect(result.releasedBy).toBe(UNIDENTIFIED_RELEASER);
    expect(result.strippedFrom).toBe('worker-a');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(UNIDENTIFIED_RELEASER);
  });

  // (e) BANNER, arm 4 — the shape the force-forwarding opened: a board/plugin
  // override strips a holder who is MID-STEP (the expensive case the lease
  // exists for) while supplying no caller id. Same attribution requirement,
  // plus the durable handoff record.
  it('attributes a caller-less forced strip of a mid-step holder to a non-agent actor', async () => {
    seedTask('worker-a', [{
      stepId: 'step-1', description: 'long build', status: 'IN_PROGRESS', affectedFiles: [],
    }]);
    seedWorker('worker-a');
    await state.load();
    const posted: string[] = [];
    vi.spyOn(state, 'postToGeneral').mockImplementation(async (content: string) => { posted.push(content); });

    const tool = releaseTaskTool(state);
    const result = await tool.handler({
      taskId: 'task-1',
      force: true,
      handoffNote: { whatIsDone: 'partial', whatRemains: 'the rest' },
    }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.releasedBy).toBe(UNIDENTIFIED_RELEASER);
    expect(result.strippedFrom).toBe('worker-a');
    // The persisted handoff carries the same attribution as the banner: this
    // field used to fall back to the stripped worker's id, writing the victim
    // into the durable record as its own releaser.
    expect(state.getTask('task-1')!.priorHandoffs![0].releasedBy).toBe(UNIDENTIFIED_RELEASER);
    expect(posted[0]).toContain(UNIDENTIFIED_RELEASER);
  });
});

// =============================================================================
// Attempt closing on every release path (task-b6c48bf0). A release gives the
// seat up, so the attempt that held it ends — through ONE shared helper — on
// release_task, deregister_worker, worker deletion and the startup purge alike,
// keyed on the seat and never on where nextStatusForRelease routed the task.
// The deregister and purge cases live here on purpose: this file and
// claimNextTask.test.ts are the task's named verification command, and neither
// deregisterWorker.test.ts nor workerStore.test.ts exists.
// =============================================================================
describe('attempt closing on the release paths', () => {
  const h = new ToolTestHarness();

  beforeEach(() => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  /** A task held by `workerId`, with the worker's record pointing back at it. */
  function seedHeldTask(taskId: string, workerId: string, overrides: Partial<Task> = {}): void {
    h.createTask({ id: taskId, status: 'WORKING', assignedWorkerId: workerId, ...overrides });
    h.createWorker({ id: workerId, status: 'CODING', currentTaskId: taskId });
  }

  async function openFor(taskId: string, workerId: string): Promise<ExecutionAttempt> {
    return openAttempt(h.state, { taskId, workerId, runnerId: workerId, workspace: h.testDir });
  }

  /** A record written the way a previous daemon run left it — BEFORE load(). */
  function persistAttempt(fields: Pick<ExecutionAttempt, 'id' | 'taskId' | 'workerId' | 'generation' | 'phase'>): void {
    const dir = path.join(h.moePath, 'attempts');
    fs.mkdirSync(dir, { recursive: true });
    const record: ExecutionAttempt = {
      runnerId: fields.workerId,
      workspace: h.testDir,
      startedAt: '2026-09-11T00:00:00.000Z',
      lastPhaseAt: '2026-09-11T00:00:00.000Z',
      ...fields,
    };
    fs.writeFileSync(path.join(dir, `${fields.id}.json`), JSON.stringify(record, null, 2));
  }

  /** [generation, workerId, phase] for each attempt of the task, in generation order. */
  function attemptsOf(taskId: string): Array<[number, string, ExecutionAttemptPhase]> {
    return listAttempts(h.state, taskId).map((a) => [a.generation, a.workerId, a.phase]);
  }

  function readMoeFile(...segments: string[]): string {
    return fs.readFileSync(path.join(h.moePath, ...segments), 'utf8');
  }

  async function release(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await releaseTaskTool(h.state).handler(args, h.state) as Record<string, unknown>;
  }

  async function claimAs(workerId: string, taskId: string): Promise<{ attemptId: string; generation: number }> {
    return await claimNextTaskTool(h.state).handler(
      { statuses: ['WORKING'], taskId, workerId }, h.state) as { attemptId: string; generation: number };
  }

  it('release_task closes the attempt it releases and leaves none open for the unassigned task', async () => {
    seedHeldTask('task-1', 'worker-a');
    await h.state.load();
    const attempt = await openFor('task-1', 'worker-a');

    await release({ taskId: 'task-1', workerId: 'worker-a' });

    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(currentAttempt(h.state, 'task-1')).toBeNull();
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'closed']]);
    // Closed on disk and KEPT: generations are allocated over every prior record.
    expect(JSON.parse(readMoeFile('attempts', `${attempt.id}.json`))).toMatchObject({
      id: attempt.id, taskId: 'task-1', generation: 1, phase: 'closed',
    });
  });

  it('closes on the seat, not the routed status: an all-steps-done release routed to REVIEW still closes', async () => {
    seedHeldTask('task-1', 'worker-a', {
      implementationPlan: [{ stepId: 'step-1', description: 'done', status: 'COMPLETED', affectedFiles: [] }],
    });
    await h.state.load();
    await openFor('task-1', 'worker-a');

    const result = await release({ taskId: 'task-1', workerId: 'worker-a' });

    expect(result.status).toBe('REVIEW');
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'closed']]);
  });

  it('leaves the attempt running when the release is refused', async () => {
    seedHeldTask('task-1', 'worker-a');
    await h.state.load();
    await openFor('task-1', 'worker-a');

    await expect(release({ taskId: 'task-1', workerId: 'worker-b' }))
      .rejects.toMatchObject({ codeName: 'RELEASE_NOT_ASSIGNEE' });

    expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-a');
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'running']]);
  });

  it('release_task closes every open attempt of the task, not only the newest', async () => {
    // openAttempt cannot produce two open records for one task; a restored backup
    // or a hand-edited file can. The seat is given up, so neither may survive.
    seedHeldTask('task-1', 'worker-a');
    persistAttempt({ id: 'attempt-old', taskId: 'task-1', workerId: 'worker-a', generation: 1, phase: 'running' });
    persistAttempt({ id: 'attempt-new', taskId: 'task-1', workerId: 'worker-a', generation: 2, phase: 'running' });
    await h.state.load();

    await release({ taskId: 'task-1', workerId: 'worker-a' });

    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'closed'], [2, 'worker-a', 'closed']]);
  });

  it('deregister_worker closes the attempt of every task the worker held, and only those', async () => {
    seedHeldTask('task-1', 'worker-a');
    // An out-of-sync second hold: the release loop scans tasks, not currentTaskId.
    h.createTask({ id: 'task-2', status: 'REVIEW', assignedWorkerId: 'worker-a', order: 2 });
    seedHeldTask('task-3', 'worker-b', { order: 3 });
    await h.state.load();
    await openFor('task-1', 'worker-a');
    await openFor('task-2', 'worker-a');
    await openFor('task-3', 'worker-b');

    const result = await deregisterWorkerTool(h.state).handler(
      { workerId: 'worker-a', reason: 'terminal_closed' }, h.state) as { releasedTaskIds: string[] };

    expect([...result.releasedTaskIds].sort()).toEqual(['task-1', 'task-2']);
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'closed']]);
    expect(attemptsOf('task-2')).toEqual([[1, 'worker-a', 'closed']]);
    // A bystander's seat was not given up, so its attempt keeps running.
    expect(attemptsOf('task-3')).toEqual([[1, 'worker-b', 'running']]);
  });

  it('worker deletion closes the attempts of the tasks it releases', async () => {
    seedHeldTask('task-1', 'worker-a');
    await h.state.load();
    await openFor('task-1', 'worker-a');

    await h.state.deleteWorker('worker-a');

    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'closed']]);
  });

  /** A task pointing at a worker with NO record — the dangling assignment the purge releases. */
  function seedDanglingTask(taskId: string, workerId: string, overrides: Partial<Task> = {}): void {
    h.createTask({ id: taskId, status: 'WORKING', assignedWorkerId: workerId, ...overrides });
  }

  it('the startup purge closes the attempt of every task it releases, over records loaded from disk', async () => {
    // index.ts runs load() and THEN purgeAllWorkers(); mirror that order over
    // records a previous daemon run persisted.
    //
    // A worker whose RECORD survives and owns a non-closed attempt is now
    // SPARED — its task is held for it rather than released, so its attempt is
    // never reached (state/workerStore.test.ts owns that rule). What the purge
    // still releases, and therefore still closes, is a DANGLING assignment: a
    // task pointing at a worker with no record at all, where no seat is left to
    // hold the row for.
    seedHeldTask('task-1', 'worker-a');
    seedDanglingTask('task-2', 'architect-b', { status: 'PLANNING', order: 2 });
    persistAttempt({ id: 'attempt-1', taskId: 'task-1', workerId: 'worker-a', generation: 1, phase: 'running' });
    persistAttempt({ id: 'attempt-2', taskId: 'task-2', workerId: 'architect-b', generation: 3, phase: 'running' });
    await h.state.load();

    await h.state.purgeAllWorkers();

    // Held: the seat exists and still owns an open attempt.
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-a');
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'running']]);
    // Released, and its attempt closed with it — on disk, not just in the map.
    expect(h.state.getTask('task-2')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-2')).toEqual([[3, 'architect-b', 'closed']]);
    expect(JSON.parse(readMoeFile('attempts', 'attempt-2.json')).phase).toBe('closed');
  });

  it('the startup purge survives an attempt it cannot close: one bad record never aborts startup', async () => {
    // Both dangling, so both seats are genuinely released and both attempts are
    // reached; a surviving worker record would spare its seat instead.
    seedDanglingTask('task-1', 'worker-a');
    seedDanglingTask('task-2', 'worker-b', { order: 2 });
    persistAttempt({ id: 'attempt-1', taskId: 'task-1', workerId: 'worker-a', generation: 1, phase: 'running' });
    persistAttempt({ id: 'attempt-2', taskId: 'task-2', workerId: 'worker-b', generation: 1, phase: 'running' });
    await h.state.load();
    const realWrite = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
      if (args[0] === 'attempts' && args[1] === 'attempt-1') throw new Error('EPERM: attempt-1 is unwritable');
      return realWrite(...args);
    });

    await expect(h.state.purgeAllWorkers()).resolves.toBeUndefined();

    // Both seats were still released, and the other task's attempt still closed.
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(h.state.getTask('task-2')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'running']]);
    expect(attemptsOf('task-2')).toEqual([[1, 'worker-b', 'closed']]);
  });

  it('the startup purge closes the attempt even when the task write fails: the seat is gone in memory', async () => {
    // Dangling, so the purge actually releases it; a surviving worker record
    // would be spared and this path never entered.
    seedDanglingTask('task-1', 'worker-a');
    persistAttempt({ id: 'attempt-1', taskId: 'task-1', workerId: 'worker-a', generation: 1, phase: 'running' });
    await h.state.load();
    const realWrite = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
      if (args[0] === 'tasks') throw new Error('EPERM: task-1 is unwritable');
      return realWrite(...args);
    });

    await expect(h.state.purgeAllWorkers()).resolves.toBeUndefined();

    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'closed']]);
  });

  it('keeps the attempt when the unassign itself fails, on deregister and on deletion', async () => {
    seedHeldTask('task-1', 'worker-a');
    seedHeldTask('task-2', 'worker-b', { order: 2 });
    await h.state.load();
    await openFor('task-1', 'worker-a');
    await openFor('task-2', 'worker-b');
    const realUpdate = h.state.updateTask.bind(h.state);
    vi.spyOn(h.state, 'updateTask').mockImplementation(async (...args: Parameters<StateManager['updateTask']>) => {
      if (args[1].assignedWorkerId === null) throw new Error('EIO: task write failed');
      return realUpdate(...args);
    });

    await deregisterWorkerTool(h.state).handler({ workerId: 'worker-a' }, h.state);
    await h.state.deleteWorker('worker-b');

    // Neither seat was actually given up, so neither attempt may end.
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-a');
    expect(h.state.getTask('task-2')!.assignedWorkerId).toBe('worker-b');
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'running']]);
    expect(attemptsOf('task-2')).toEqual([[1, 'worker-b', 'running']]);
  });

  it('releases a task that never had an attempt silently on every path (legacy rows predate attempts)', async () => {
    seedHeldTask('task-1', 'worker-a');
    seedHeldTask('task-2', 'worker-b', { order: 2 });
    seedHeldTask('task-3', 'worker-c', { order: 3 });
    await h.state.load();

    const released = await release({ taskId: 'task-1', workerId: 'worker-a' });
    const deregistered = await deregisterWorkerTool(h.state).handler(
      { workerId: 'worker-b' }, h.state) as { releasedTaskIds: string[] };
    await h.state.purgeAllWorkers();

    expect(released.success).toBe(true);
    expect(deregistered.releasedTaskIds).toEqual(['task-2']);
    for (const taskId of ['task-1', 'task-2', 'task-3']) {
      expect(h.state.getTask(taskId)!.assignedWorkerId).toBeNull();
    }
    // Closing never invents a record to close.
    expect(listAttempts(h.state)).toEqual([]);
    expect(fs.existsSync(path.join(h.moePath, 'attempts'))).toBe(false);
  });

  it('is idempotent: a second close of the same task finds nothing open and rewrites nothing', async () => {
    seedHeldTask('task-1', 'worker-a');
    await h.state.load();
    const attempt = await openFor('task-1', 'worker-a');
    await release({ taskId: 'task-1', workerId: 'worker-a' });
    const closedBytes = readMoeFile('attempts', `${attempt.id}.json`);
    expect(JSON.parse(closedBytes).phase).toBe('closed');
    // A pre-rollout-style assignment (no attempt opened), released again: the
    // close now runs over a task whose only record is already closed.
    await h.state.updateTask('task-1', { assignedWorkerId: 'worker-a' });

    await release({ taskId: 'task-1', workerId: 'worker-a' });

    expect(readMoeFile('attempts', `${attempt.id}.json`)).toBe(closedBytes);
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'closed']]);
  });

  it('refuses a late generation-1 release after the same worker re-claimed as generation 2, writing nothing', async () => {
    h.createTask({
      id: 'task-G',
      status: 'WORKING',
      implementationPlan: [{ stepId: 'step-1', description: 'Pending fixture step', status: 'PENDING', affectedFiles: ['file.ts'] }],
    });
    h.createWorker({ id: 'worker-W' });
    await h.state.load();
    const claimN = await claimAs('worker-W', 'task-G');
    const releaseN = {
      taskId: 'task-G',
      workerId: 'worker-W',
      attemptId: claimN.attemptId,
      generation: 1,
      reason: 'Explicit handoff: runner restarting the seat on a fresh CLI.',
      handoffNote: { whatIsDone: 'Read the plan.', whatRemains: 'Execute step-1.' },
    };
    await release({ ...releaseN });
    const claimN1 = await claimAs('worker-W', 'task-G');
    expect(claimN.generation).toBe(1);
    expect(claimN1.generation).toBe(2);
    const snapshot = () => ({
      task: readMoeFile('tasks', 'task-G.json'),
      worker: readMoeFile('workers', 'worker-W.json'),
      attemptN: readMoeFile('attempts', `${claimN.attemptId}.json`),
      attemptN1: readMoeFile('attempts', `${claimN1.attemptId}.json`),
    });
    const before = snapshot();

    const stale = await release({ ...releaseN }).then(() => null, (err: unknown) => err);

    expect(stale).toBeInstanceOf(MoeError);
    expect((stale as MoeError).code).toBe(-32002);
    expect((stale as MoeError).codeName).toBe('ATTEMPT_SUPERSEDED');
    expect(snapshot()).toEqual(before);
    expect(h.state.getTask('task-G')!.assignedWorkerId).toBe('worker-W');

    // POSITIVE CONTROL: the CURRENT generation still releases, and closes its attempt.
    await release({ ...releaseN, attemptId: claimN1.attemptId, generation: 2 });
    expect(h.state.getTask('task-G')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-G')).toEqual([[1, 'worker-W', 'closed'], [2, 'worker-W', 'closed']]);
  });

  it('refuses a malformed attempt identity as invalid input without releasing anything', async () => {
    seedHeldTask('task-1', 'worker-a');
    await h.state.load();
    const attempt = await openFor('task-1', 'worker-a');

    await expect(release({ taskId: 'task-1', workerId: 'worker-a', attemptId: attempt.id, generation: 0 }))
      .rejects.toMatchObject({ code: -32602, codeName: 'INVALID_INPUT' });
    // Bounded before use: a refusal message echoes the presented id.
    await expect(release({ taskId: 'task-1', workerId: 'worker-a', attemptId: 'x'.repeat(129) }))
      .rejects.toMatchObject({ code: -32602, codeName: 'INVALID_INPUT' });

    expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-a');
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'running']]);
  });
});

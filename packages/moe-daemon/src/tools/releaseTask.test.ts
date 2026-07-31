import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { releaseTaskTool } from './releaseTask.js';
import { computeDiskStateSignature } from '../util/diskState.js';
import type { Project, Epic, HandoffNote, Task, Worker } from '../types/schema.js';

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

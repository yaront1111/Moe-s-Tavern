// =============================================================================
// Governance plane v2 — cross-feature composition gate
// =============================================================================
//
// The epic's mid-task suites each prove ONE feature in isolation. This suite is
// the integration gate: it drives the real tools end-to-end and fails if two
// features that were built separately stop composing. Only the disk-signature
// boundary (a git subprocess) is mocked — its parser/subprocess behaviour is
// owned by util/diskState.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool } from './submitPlan.js';
import { releaseTaskTool } from './releaseTask.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { computeDiskStateSignature } from '../util/diskState.js';
import type { Epic, HandoffNote, Project, ProjectSettings, Task } from '../types/schema.js';

// Only the git boundary is mocked: the subprocess and its porcelain parser are
// covered by util/diskState.test.ts, and shelling out here would make the
// composition non-deterministic.
vi.mock('../util/diskState.js', () => ({ computeDiskStateSignature: vi.fn() }));
const mockedSignature = vi.mocked(computeDiskStateSignature);

const EXISTING_FILE = 'src/existing.ts';
const MISSING_FILE = 'src/created-by-this-task.ts';

describe('governance plane v2 — cross-feature composition', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupProject(settings: Partial<ProjectSettings> = {}): void {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
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
        ...settings,
      } as ProjectSettings,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));

    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  }

  function writeTask(overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 'Compose the gates', description: '',
      definitionOfDone: ['it composes'], taskRails: [], implementationPlan: [],
      status: 'PLANNING', assignedWorkerId: 'architect-1', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', task.id + '.json'), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-gov-v2-'));
    moePath = path.join(testDir, '.moe');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('submit_plan: path gate + newFiles exemption + size warning', () => {
    /** Three steps: two distinct files, so both warn thresholds are crossed but neither max is. */
    function planSteps(withNewFiles: boolean) {
      return [
        { description: 'Read the existing module and its tests', affectedFiles: [EXISTING_FILE] },
        {
          description: 'Create the new module with error handling',
          affectedFiles: [MISSING_FILE],
          ...(withNewFiles ? { newFiles: [MISSING_FILE] } : {}),
        },
        { description: 'Wire the new module into the existing one', affectedFiles: [EXISTING_FILE, MISSING_FILE] },
      ];
    }

    async function submit(withNewFiles: boolean): Promise<Record<string, unknown>> {
      return await submitPlanTool(state).handler(
        { taskId: 'task-1', workerId: 'architect-1', steps: planSteps(withNewFiles) },
        state
      ) as Record<string, unknown>;
    }

    beforeEach(async () => {
      setupProject({
        // Warn on this plan (3 steps / 2 files) without rejecting it.
        taskSizing: { warnSteps: 2, maxSteps: 12, warnDistinctFiles: 1, maxDistinctFiles: 10 },
      });
      writeTask();
      // One real file inside the temporary project; the other path stays absent.
      fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(testDir, EXISTING_FILE), 'export const existing = 1;\n');
      state = new StateManager({ projectPath: testDir });
      await state.load();
    });

    it('rejects the undeclared missing path with a teaching error and leaves the task untouched', async () => {
      await expect(submit(false)).rejects.toThrow(
        new RegExp(`${MISSING_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*newFiles`)
      );

      // The rejection must be total: no plan, no size warnings.
      const task = state.getTask('task-1')!;
      expect(task.status).toBe('PLANNING');
      expect(task.implementationPlan).toEqual([]);
      expect(task.planSizeWarnings).toBeUndefined();
      // The path that DOES exist is never reported as missing.
      expect(fs.existsSync(path.join(testDir, EXISTING_FILE))).toBe(true);
    });

    it('accepts the corrected resubmit and composes newFiles and size warning in one write', async () => {
      await expect(submit(false)).rejects.toThrow(/newFiles/);

      const result = await submit(true);

      expect(result.success).toBe(true);
      expect(result.status).toBe('WORKING'); // TURBO auto-approval
      expect(result.stepCount).toBe(3);
      expect(result.newFileCount).toBe(1);
      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('steps')]));

      const task = state.getTask('task-1')!;
      // newFiles survives the plan sanitizer's allowlist.
      expect(task.implementationPlan[1].newFiles).toEqual([MISSING_FILE]);
      expect(task.implementationPlan[0].newFiles ?? []).toEqual([]);
      expect(task.planSizeWarnings?.length).toBeGreaterThan(0);
      expect(task.status).toBe('WORKING');
    });
  });

  describe('release → human unpark → claim: refusal cascade + disk-state staleness', () => {
    const NOW = '2026-07-31T12:00:00.000Z';
    const NOW_MS = Date.parse(NOW);
    const RELEASE_SIG = 'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2:1111111111';
    const CLAIM_SIG = 'v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:5:2222222222';
    const EMPTY_NOTE = { whatIsDone: 'nothing', whatRemains: 'all of it' };

    let rolePosts: Array<[string, string]>;

    /** A prior release that reported no progress, `hoursAgo` before NOW. */
    function refusal(hoursAgo: number): HandoffNote {
      return {
        whatIsDone: 'nothing',
        whatRemains: 'all of it',
        releasedBy: `worker-${hoursAgo}h`,
        releasedAt: new Date(NOW_MS - hoursAgo * 3_600_000).toISOString(),
      };
    }

    async function release(): Promise<Record<string, unknown>> {
      return await releaseTaskTool(state).handler(
        { taskId: 'task-1', workerId: 'worker-old', handoffNote: EMPTY_NOTE },
        state
      ) as Record<string, unknown>;
    }

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW_MS);
      setupProject();
      writeTask({
        status: 'WORKING',
        assignedWorkerId: 'worker-old',
        implementationPlan: [{ stepId: 'step-1', description: 'do the thing', status: 'IN_PROGRESS', affectedFiles: [] }],
        priorHandoffs: [refusal(2), refusal(20)],
      });
      state = new StateManager({ projectPath: testDir });
      await state.load();
      await state.createWorker({
        id: 'worker-old', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
        currentTaskId: 'task-1', status: 'CODING',
      });

      mockedSignature.mockReset();
      mockedSignature.mockResolvedValueOnce(RELEASE_SIG).mockResolvedValue(CLAIM_SIG);

      rolePosts = [];
      vi.spyOn(state, 'postToRoleChannel').mockImplementation(async (role: string, content: string) => {
        rolePosts.push([role, content]);
      });
      vi.spyOn(state, 'postToGeneral').mockResolvedValue(undefined);
    });

    it('parks the third empty-progress release and flags the stale tree on the next claim', async () => {
      const released = await release();

      // Refusal cascade: third qualifying release inside 24h parks the task.
      expect(released.cascadeTriggered).toBe(true);
      expect(released.status).toBe('BACKLOG');
      expect(released.diskStateCaptured).toBe(true);
      expect(rolePosts.some(([role, content]) => role === 'governors' && content.includes('BACKLOG'))).toBe(true);

      const parked = state.getTask('task-1')!;
      expect(parked.status).toBe('BACKLOG');
      expect(parked.assignedWorkerId).toBeNull();
      // The newest handoff carries this release's signature; history is kept.
      expect(parked.priorHandoffs).toHaveLength(3);
      expect(parked.priorHandoffs![0].diskState).toBe(RELEASE_SIG);
      expect(state.getWorker('worker-old')!.status).toBe('IDLE');
      expect(state.getWorker('worker-old')!.currentTaskId).toBeNull();

      // Documented human unpark: BACKLOG → WORKING through the real tool.
      await setTaskStatusTool(state).handler({ taskId: 'task-1', status: 'WORKING' }, state);
      expect(state.getTask('task-1')!.status).toBe('WORKING');

      // A new worker claims it; the tree has moved on since that handoff.
      const claimed = await claimNextTaskTool(state).handler(
        { statuses: ['WORKING'], taskId: 'task-1', workerId: 'worker-new' },
        state
      ) as Record<string, unknown>;

      expect(claimed.hasNext).toBe(true);
      expect(claimed.staleHandoffDiskState).toBe(true);
      expect(claimed.handoffHint).toMatch(/re-verify/i);
      expect((claimed.task as { priorHandoffCount: number }).priorHandoffCount).toBe(3);
    });

    it('keeps the park when the governor notification fails', async () => {
      vi.mocked(state.postToRoleChannel).mockRejectedValue(new Error('chat down'));
      vi.mocked(state.postToGeneral).mockRejectedValue(new Error('chat down'));

      const released = await release();

      expect(released.success).toBe(true);
      expect(released.cascadeTriggered).toBe(true);
      expect(state.getTask('task-1')!.status).toBe('BACKLOG');
      expect(state.getWorker('worker-old')!.status).toBe('IDLE');
    });

    it('raises no false stale flag when the signature cannot be recomputed', async () => {
      await release();
      // Every later recompute fails (no git, not a repo, timeout).
      mockedSignature.mockReset();
      mockedSignature.mockResolvedValue(undefined);

      await setTaskStatusTool(state).handler({ taskId: 'task-1', status: 'WORKING' }, state);
      const claimed = await claimNextTaskTool(state).handler(
        { statuses: ['WORKING'], taskId: 'task-1', workerId: 'worker-new' },
        state
      ) as Record<string, unknown>;

      expect(claimed.hasNext).toBe(true);
      expect(claimed.staleHandoffDiskState).toBeUndefined();
      expect(claimed.handoffHint).not.toMatch(/re-verify/i);
    });

    it('raises no stale flag when the tree is unchanged since the handoff', async () => {
      await release();
      mockedSignature.mockReset();
      mockedSignature.mockResolvedValue(RELEASE_SIG);

      await setTaskStatusTool(state).handler({ taskId: 'task-1', status: 'WORKING' }, state);
      const claimed = await claimNextTaskTool(state).handler(
        { statuses: ['WORKING'], taskId: 'task-1', workerId: 'worker-new' },
        state
      ) as Record<string, unknown>;

      expect(claimed.staleHandoffDiskState).toBeUndefined();
    });
  });
});

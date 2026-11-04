// A re-plan that omits `effort` keeps the task's stored effort, but never below
// the tier minimum (light/standard high, heavy xhigh): the same floor an
// explicit effort gets. resolveLaunch applies the floor to a stored effort too,
// so no row launches below its tier's minimum. A docs/tests-only row has none.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool, clearAllSpeedModeTimeouts } from './submitPlan.js';
import { resolveLaunch } from '../util/routing.js';

describe('submit_plan and resolveLaunch keep a stored effort at or above the tier minimum', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setup() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(moePath, sub));
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test', name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      // Routing and taskSizing at their defaults, as in the live project.json.
      settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false, branchPattern: '', commitPattern: '', agentCommand: 'claude' },
      createdAt: now, updatedAt: now,
    }, null, 2));
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify({
      id: 'epic-1', projectId: 'proj-test', title: 'Epic', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now,
    }, null, 2));
  }

  // A row back in PLANNING after an earlier standard-tier plan picked effort 'high'
  // (a human plan reject, a critique block, request_replan and the qa auto-replan all keep tier/effort).
  function writeTask(id: string, extra: Record<string, unknown>) {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify({
      id, epicId: 'epic-1', title: id, description: '', definitionOfDone: ['Done'], taskRails: [],
      implementationPlan: [], status: 'PLANNING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null, priority: 'MEDIUM',
      order: 1, comments: [], createdAt: now, updatedAt: now, planRevision: 2, ...extra,
    }, null, 2));
  }

  // 6 distinct files (past warnDistinctFiles 5): planSizeFloor is heavy. newFiles skip the existence gate.
  const sixFileSteps = [
    { description: 'Step 1', newFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
    { description: 'Step 2', newFiles: ['src/d.ts', 'src/e.ts', 'src/f.ts'] },
  ];
  type R = { tier: string; launch: { tier: string; effort: string } };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-effort-floor-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });
  afterEach(() => {
    clearAllSpeedModeTimeouts();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('control: an explicit effort high on a heavy re-plan is raised to xhigh', async () => {
    setup();
    writeTask('task-1', { tier: 'standard', effort: 'high' });
    await state.load();
    const res = await submitPlanTool(state).handler({ taskId: 'task-1', steps: sixFileSteps, effort: 'high' }, state) as R;
    expect(res.tier).toBe('heavy');
    expect(state.getTask('task-1')?.effort).toBe('xhigh');
    expect(res.launch.effort).toBe('xhigh');
  });

  it('an omitted effort on a re-plan the size floor raises to heavy is stored and launched at the heavy minimum', async () => {
    setup();
    writeTask('task-1', { tier: 'standard', effort: 'high' });
    await state.load();
    const res = await submitPlanTool(state).handler({ taskId: 'task-1', steps: sixFileSteps }, state) as R;
    expect(res.tier).toBe('heavy');
    const stored = state.getTask('task-1')!;
    expect(['xhigh', 'max']).toContain(stored.effort);
    expect(res.launch.effort).toBe(stored.effort);
    expect(resolveLaunch(stored, state.project?.settings, 'worker')?.effort).toBe(stored.effort);
  });

  it('an explicit tier heavy with effort omitted is floored too', async () => {
    setup();
    writeTask('task-1', { tier: 'standard', effort: 'high' });
    await state.load();
    const res = await submitPlanTool(state).handler({
      taskId: 'task-1', tier: 'heavy', steps: [{ description: 'Step 1', newFiles: ['src/a.ts'] }],
    }, state) as R;
    expect(res.tier).toBe('heavy');
    expect(['xhigh', 'max']).toContain(state.getTask('task-1')?.effort);
    expect(['xhigh', 'max']).toContain(res.launch.effort);
  });

  it('a re-plan that stays standard keeps its stored effort high', async () => {
    setup();
    writeTask('task-1', { tier: 'standard', effort: 'high' });
    await state.load();
    const res = await submitPlanTool(state).handler({
      taskId: 'task-1', steps: [{ description: 'Step 1', newFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }],
    }, state) as R;
    expect(res.tier).toBe('standard');
    expect(state.getTask('task-1')?.effort).toBe('high');
    expect(res.launch.effort).toBe('high');
  });

  it('resolveLaunch floors a stored effort below its tier minimum, and only that', () => {
    const row = (tier: string, effort: string, lowEffortEligible = false) =>
      ({ tier, effort, status: 'WORKING', lowEffortEligible }) as unknown as Parameters<typeof resolveLaunch>[0];
    expect(resolveLaunch(row('heavy', 'high'))?.effort).toBe('xhigh');
    expect(resolveLaunch(row('heavy', 'max'))?.effort).toBe('max');
    expect(resolveLaunch(row('standard', 'high'))?.effort).toBe('high');
    expect(resolveLaunch(row('light', 'high'))?.effort).toBe('high');
    // A docs/tests-only row has no tier minimum: its low effort is kept.
    expect(resolveLaunch(row('heavy', 'low', true))?.effort).toBe('low');
  });
});

// submit_plan refuses what it cannot store whole (task-e67470ce). Cases port
// hunt task-928a468d's planStepCap and planningNotesIntake repros: the plan
// sanitizer kept 50 steps while submit_plan accepted 100, and planningNotes
// was clipped or coerced where the execution contract beside it is refused.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool, clearAllSpeedModeTimeouts } from './submitPlan.js';
import { MAX_PLAN_STEPS, sanitizeImplementationPlan } from '../state/validators.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';

describe('submit_plan stores every accepted step and refuses malformed planningNotes', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setup(ids: string[]) {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(moePath, sub));
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test', name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'CONTROL', speedModeDelayMs: 2000, autoCreateBranch: false, branchPattern: '', commitPattern: '', agentCommand: 'claude' },
      createdAt: now, updatedAt: now,
    }, null, 2));
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify({
      id: 'epic-1', projectId: 'proj-test', title: 'Epic', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now,
    }, null, 2));
    ids.forEach((id, i) => fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify({
      id, epicId: 'epic-1', title: id, description: '', definitionOfDone: ['Done'], taskRails: [],
      implementationPlan: [], status: 'PLANNING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null, priority: 'MEDIUM',
      order: i + 1, comments: [], createdAt: now, updatedAt: now,
    }, null, 2)));
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plan-intake-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });
  afterEach(() => {
    clearAllSpeedModeTimeouts();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ description: `Step ${i + 1}: do part ${i + 1}` }));
  const submit = (taskId: string, extra: Record<string, unknown> = {}, steps: unknown[] = [{ description: 'Step 1' }]) =>
    submitPlanTool(state).handler({ taskId, steps, ...extra }, state);
  const notesOf = (id: string) => (state.getTask(id) as unknown as { planningNotes?: unknown }).planningNotes;
  // A refusal is a coded INVALID_INPUT naming the field, and the call wrote nothing.
  async function refused(id: string, call: Promise<unknown>, field: string): Promise<MoeError> {
    const err = await call.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(MoeError);
    expect({ code: (err as MoeError).code, field: (err as MoeError).context?.field })
      .toEqual({ code: MoeErrorCode.INVALID_INPUT, field });
    const t = state.getTask(id)!;
    expect({ status: t.status, steps: t.implementationPlan.length, notes: notesOf(id) })
      .toEqual({ status: 'PLANNING', steps: 0, notes: undefined });
    return err as MoeError;
  }

  it('stores every step of an accepted 60-step plan, in memory, on disk and after a reload', async () => {
    setup(['task-big']);
    await state.load();
    await state.updateSettings({ taskSizing: { warnSteps: 60, maxSteps: 60 } });
    const res = await submit('task-big', {}, many(60)) as { success: boolean; stepCount: number };
    expect(res).toMatchObject({ success: true, stepCount: 60 });
    const task = state.getTask('task-big')!;
    expect(task.metrics?.plannedStepCount).toBe(60);
    expect(task.implementationPlan.length).toBe(60);
    expect(task.implementationPlan.at(-1)?.stepId).toBe('step-60');
    const onDisk = JSON.parse(fs.readFileSync(path.join(moePath, 'tasks', 'task-big.json'), 'utf-8'));
    expect(onDisk.implementationPlan.length).toBe(60);
    state = new StateManager({ projectPath: testDir });
    await state.load();
    expect(state.getTask('task-big')!.implementationPlan.length).toBe(60);
  });

  it(`stores a plan of exactly MAX_PLAN_STEPS (${MAX_PLAN_STEPS}) steps and refuses one more before any write`, async () => {
    setup(['task-max', 'task-over']);
    await state.load();
    await state.updateSettings({ taskSizing: { warnSteps: MAX_PLAN_STEPS, maxSteps: MAX_PLAN_STEPS } });
    await submit('task-max', {}, many(MAX_PLAN_STEPS));
    expect(state.getTask('task-max')!.implementationPlan.length).toBe(MAX_PLAN_STEPS);
    const err = await refused('task-over', submit('task-over', {}, many(MAX_PLAN_STEPS + 1)), 'steps');
    expect(err.message).toContain(`maximum ${MAX_PLAN_STEPS} steps allowed`);
  });

  it('the plan sanitizer and the taskSizing validator share that bound', async () => {
    expect(MAX_PLAN_STEPS).toBe(100);
    expect(sanitizeImplementationPlan(many(MAX_PLAN_STEPS + 5))).toHaveLength(MAX_PLAN_STEPS);
    setup([]);
    await state.load();
    for (const key of ['warnSteps', 'maxSteps']) {
      const err = await state.updateSettings({ taskSizing: { [key]: MAX_PLAN_STEPS + 1 } }).then(() => undefined, (e: unknown) => e);
      expect((err as MoeError).code).toBe(MoeErrorCode.INVALID_INPUT);
    }
  });

  it('control: an oversized executionContract field is refused INVALID_INPUT', async () => {
    setup(['task-c']);
    await state.load();
    await refused('task-c', submit('task-c', { executionContract: { intendedBehavior: 'x'.repeat(2001) } }), 'executionContract.intendedBehavior');
  });

  it('a non-string note is refused INVALID_INPUT, not an uncoded TypeError', async () => {
    setup(['task-n']);
    await state.load();
    await refused('task-n', submit('task-n', { planningNotes: { risks: 42 } }), 'planningNotes.risks');
  });

  it('a note over 5000 chars is refused, never clipped', async () => {
    setup(['task-r']);
    await state.load();
    await refused('task-r', submit('task-r', { planningNotes: { risks: 'r'.repeat(5990) + ' END-OF-NOTE' } }), 'planningNotes.risks');
  });

  it('keyFiles must be a string[] of at most 50 entries, each 1-1000 chars', async () => {
    setup(['task-k']);
    await state.load();
    const cases: [unknown, string][] = [
      ['packages/moe-daemon/src/tools/submitPlan.ts', 'planningNotes.keyFiles'],
      [Array.from({ length: 51 }, (_, i) => `f${i}.ts`), 'planningNotes.keyFiles'],
      [['ok.ts', 7], 'planningNotes.keyFiles[1]'],
      [['ok.ts', ''], 'planningNotes.keyFiles[1]'],
      [['x'.repeat(1001)], 'planningNotes.keyFiles[0]'],
    ];
    for (const [keyFiles, field] of cases) {
      await refused('task-k', submit('task-k', { planningNotes: { keyFiles } }), field);
    }
  });

  it('a non-object planningNotes and an unknown key are refused', async () => {
    setup(['task-o']);
    await state.load();
    await refused('task-o', submit('task-o', { planningNotes: 'notes' }), 'planningNotes');
    await refused('task-o', submit('task-o', { planningNotes: ['notes'] }), 'planningNotes');
    await refused('task-o', submit('task-o', { planningNotes: { risk: 'typo' } }), 'risk');
  });

  it('notes at the limits are stored byte-for-byte; null stores none', async () => {
    setup(['task-ok', 'task-null']);
    await state.load();
    const notes = {
      approachesConsidered: 'line one\nline two',
      codebaseInsights: '',
      risks: 'r'.repeat(5000 - 12) + ' END-OF-NOTE',
      keyFiles: Array.from({ length: 50 }, (_, i) => `packages/f${i}.ts`),
    };
    await submit('task-ok', { planningNotes: notes });
    expect(notesOf('task-ok')).toEqual(notes);
    await submit('task-null', { planningNotes: null });
    expect(notesOf('task-null')).toBeUndefined();
  });
});

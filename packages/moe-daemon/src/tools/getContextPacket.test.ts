import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { getContextTool, ROLE_OMITTED } from './getContext.js';
import { startStepTool } from './startStep.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { openAttempt } from '../state/attemptStore.js';
import {
  buildPacketManifest, DEFAULT_PACKET_BUDGET_CHARS, MANDATORY_SECTIONS, MAX_PACKET_BUDGET_CHARS,
  type PacketManifest, type PacketSection,
} from '../context/contextPacket.js';
import { definitionDigest } from '../delivery/requiredChecks.js';
import { validateExecutionContract } from '../state/validators.js';
import type { Task, TaskCommit } from '../types/schema.js';

type Ctx = Record<string, unknown> & {
  packetManifest: PacketManifest;
  servedContext: { packetId: string | null; receiptStatus: string };
};

const MANDATORY = ['allRails', 'project.globalRails', 'task.definitionOfDone', 'task.description',
  'task.executionContract', 'task.implementationPlan', 'task.taskRails'];
const CONTRACT = { intendedBehavior: 'serve the packet', acceptanceCriteria: ['manifest present'] };
const STRICT = { version: 2, profile: 'verified-local', planRevision: 3, deliveryPolicy: 'local-branch' } as const;
const SESSION = 'worker-w@2026-10-26T00:00:00Z';
const step = (n: number, description = `do step ${n}`) =>
  ({ stepId: `step-${n}`, description, status: 'PENDING' as const, affectedFiles: [] });
const at = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null | undefined)?.[k], value);
const byPath = (a: PacketSection, b: PacketSection) => (a.path < b.path ? -1 : 1);
const served = (path: string): PacketSection => ({ path, mandatory: true, status: 'served' });
const missing = (path: string, reason: string): PacketSection => ({ path, mandatory: true, status: 'missing', reason });
const trimmed = (path: string): PacketSection => ({ path, mandatory: false, status: 'omitted', reason: 'role-trim' });
const capped = (path: string, count: number): PacketSection =>
  ({ path, mandatory: false, status: 'truncated', reason: 'capped', count });
const sha = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

describe('get_context packetManifest (CQ-C01)', () => {
  const h = new ToolTestHarness();

  beforeEach(() => {
    vi.stubEnv('MOE_WORKER_ID', ''); vi.stubEnv('MOE_TASK_ID', '');
    h.init(); h.setupMoeFolder(); h.createEpic({ epicRails: ['epic rail'] });
    h.createWorker({ id: 'worker-w', currentTaskId: 'task-1', status: 'CODING' });
  });
  afterEach(() => { h.state.clearEmitter(); vi.restoreAllMocks(); vi.unstubAllEnvs(); h.cleanup(); });

  async function seed(over: Partial<Task> = {}): Promise<Task> {
    h.createTask({
      status: 'WORKING', assignedWorkerId: 'worker-w', planRevision: 3, approvedPlanRevision: 3, order: 50,
      description: 'Build the packet', definitionOfDone: ['manifest served'], taskRails: ['task rail'],
      implementationPlan: [step(1), step(2)], executionContract: CONTRACT, ...over,
    } as Partial<Task>);
    await h.state.load();
    return h.state.getTask('task-1')!;
  }
  const read = (args: Record<string, unknown> = {}) =>
    getContextTool(h.state).handler({ taskId: 'task-1', ...args }, h.state) as Promise<Ctx>;
  /** The stored facts each mandatory path must serve unchanged. */
  const source = (task: Task) => ({
    project: { globalRails: h.state.project!.globalRails },
    allRails: { global: h.state.project!.globalRails.requiredPatterns, epic: ['epic rail'], task: task.taskRails },
    task,
  });
  const charsOf = (res: Ctx, paths: string[]) => paths.reduce((n, p) => n + JSON.stringify(at(res, p)).length, 0);

  it.each(['worker-w', 'qa-q', 'architect-a', 'governor-g', ''])(
    'serves every mandatory section whole to caller "%s" in both views', async (workerId) => {
      const task = await seed();
      expect([...MANDATORY_SECTIONS].sort()).toStrictEqual(MANDATORY);
      for (const paths of Object.values(ROLE_OMITTED)) expect(paths.filter((p) => MANDATORY.includes(p))).toStrictEqual([]);
      for (const view of ['default', 'full'] as const) {
        const res = await read({ workerId, ...(view === 'full' ? { view } : {}) });
        for (const p of MANDATORY) expect(at(res, p)).toStrictEqual(at(source(task), p));
        const trims = view === 'full' ? [] : (ROLE_OMITTED[workerId.split('-')[0]] ?? []).map(trimmed);
        expect(res.packetManifest).toStrictEqual({
          version: 1,
          provenance: { task: { id: 'task-1', planRevision: 3 }, epic: { id: 'epic-1' }, project: { id: 'proj-test' } },
          sections: [...MANDATORY.map(served), ...trims].sort(byPath),
          complete: trims.length === 0,
          limitations: ['no-repository-source'],
          budget: { limitChars: DEFAULT_PACKET_BUDGET_CHARS, mandatoryChars: charsOf(res, MANDATORY), status: 'within' },
        });
      }
    });

  it('lists absent or empty mandatory facts as missing and invents nothing', async () => {
    await seed({ status: 'PLANNING', description: ' ', definitionOfDone: [], taskRails: [], implementationPlan: [],
      executionContract: undefined });
    const res = await read({ workerId: 'architect-a' });
    expect(res.task).not.toHaveProperty('executionContract');
    expect(res.packetManifest.sections).toStrictEqual([
      served('allRails'), served('project.globalRails'), missing('task.definitionOfDone', 'empty'),
      missing('task.description', 'empty'), missing('task.executionContract', 'not-set'),
      missing('task.implementationPlan', 'empty'), served('task.taskRails'),
    ]);
    expect(res.packetManifest.complete).toBe(false);
    expect(res.packetManifest.budget.mandatoryChars).toBe(charsOf(res, ['allRails', 'project.globalRails', 'task.taskRails']));
  });

  it('reports compaction and caps as explicit omissions with exact counts', async () => {
    for (let i = 1; i <= 22; i++) h.createTask({ id: `task-s${i}`, order: i });
    const comment = (i: number, content = `note ${i}`) =>
      ({ id: `c${i}`, author: 'architect-a', content, timestamp: `2026-10-26T00:00:0${i}.000Z` });
    const commit = (i: number) => ({ sha: `${i}`.padStart(40, '0'), ref: 'main', kind: 'checkpoint',
      recordedAt: '2026-10-26T00:00:00.000Z', recordedBy: 'worker-w' });
    await seed({
      comments: [1, 2, 3, 4].map((i) => comment(i)).concat(comment(5, 'x'.repeat(2000))),
      commits: Array.from({ length: 23 }, (_, i) => commit(i)) as TaskCommit[],
      rejectionHistory: Array.from({ length: 7 }, (_, i) => ({ reason: `r${i}`, rejectedAt: '2026-10-26T00:00:00.000Z', reopenCount: i })),
    });
    const comments: PacketSection = { path: 'task.comments', mandatory: false, status: 'truncated', reason: 'compacted', count: 4 };
    const manifest = async (workerId: string) => (await read({ workerId, commentsLimit: 2 })).packetManifest;
    const arch = await manifest('architect-a');
    expect(arch.sections.filter((s) => !s.mandatory)).toStrictEqual([
      comments, capped('task.commits', 3), capped('task.epicSiblings', 2), capped('task.rejectionHistory', 2),
    ]);
    expect(arch.complete).toBe(false);
    expect(arch.limitations).toStrictEqual(['no-repository-source']);
    expect((await manifest('qa-q')).sections.filter((s) => !s.mandatory)).toStrictEqual([
      trimmed('planningNotes'), trimmed('routing'), comments, capped('task.commits', 3),
      trimmed('task.epicSiblings'), capped('task.rejectionHistory', 2),
    ]);
  });

  const pastCap: Array<[string[], PacketSection[]]> = [
    [['task-s1'], [capped('task.epicSiblings', 1)]], [['task-s1', 'task-s2'], []],
  ];
  it.each(pastCap)('counts only siblings left out: declared targets %j past the cap are served', async (dependsOn, optional) => {
    for (let i = 1; i <= 22; i++) h.createTask({ id: `task-s${i}`, order: i });
    await seed({ dependsOn });
    const { packetManifest } = await read({ workerId: 'architect-a' });
    expect(packetManifest.sections.filter((s) => !s.mandatory)).toStrictEqual(optional);
    expect(packetManifest.complete).toBe(optional.length === 0);
  });

  it('builds from odd shapes without throwing: own properties only, truncated chat, conditional check snapshot', () => {
    const input = { planRevision: null, roleOmitted: [], siblingsBeyondCap: 0, commitsTotal: 0, rejectionsTotal: 0,
      budgetChars: DEFAULT_PACKET_BUDGET_CHARS };
    const task = Object.assign(Object.create({ description: 'inherited', definitionOfDone: ['inherited'] }) as object,
      { id: 't', requiredCheckSnapshot: { revision: 'r' } });
    const chat = { recentMessages: [{ contentTruncated: true }, {}, { contentTruncated: true }] };
    expect(buildPacketManifest({ project: { id: 'p' }, epic: null, task, chat, currentCandidate: { id: 'cand-1' } }, input))
      .toStrictEqual({
        version: 1,
        provenance: { task: { id: 't', planRevision: null }, epic: null, project: { id: 'p' }, candidate: { id: 'cand-1' } },
        sections: [
          missing('allRails', 'not-set'),
          { path: 'chat.recentMessages', mandatory: false, status: 'truncated', reason: 'compacted', count: 2 },
          missing('project.globalRails', 'not-set'), missing('task.definitionOfDone', 'not-set'),
          missing('task.description', 'not-set'), missing('task.executionContract', 'not-set'),
          missing('task.implementationPlan', 'not-set'), served('task.requiredCheckSnapshot'), missing('task.taskRails', 'not-set'),
        ],
        complete: false,
        limitations: ['no-repository-source', 'plan-revision-unreadable'],
        budget: { limitChars: DEFAULT_PACKET_BUDGET_CHARS, mandatoryChars: 16, status: 'within' },
      });
    const atBudget = (budgetChars: number) => buildPacketManifest({ task }, { ...input, budgetChars }).budget;
    expect([atBudget(16), atBudget(15)]).toStrictEqual([{ limitChars: 16, mandatoryChars: 16, status: 'within' },
      { limitChars: 15, mandatoryChars: 16, status: 'overflow', requirement: 'expand' }]);
    const junk = buildPacketManifest({ project: 1, task: 'x', allRails: null }, { ...input, planRevision: 2 });
    expect(junk.sections.map((s) => s.status)).toStrictEqual(Array(7).fill('missing'));
  });

  it('lists the check overlay missing only when requiredChecks are declared and no snapshot is served', () => {
    const input = { planRevision: 1, roleOmitted: [], siblingsBeyondCap: 0, commitsTotal: 0, rejectionsTotal: 0,
      budgetChars: DEFAULT_PACKET_BUDGET_CHARS };
    const snapshotRows = (task: unknown) => {
      const m = buildPacketManifest({ task }, input);
      return { rows: m.sections.filter((s) => s.path === 'task.requiredCheckSnapshot'), mandatoryChars: m.budget.mandatoryChars };
    };
    const unbound = missing('task.requiredCheckSnapshot', 'unbound-snapshot');
    const declared = { executionContract: { requiredChecks: [{ id: 'unit' }] } };
    const base = snapshotRows({ executionContract: {} });
    const gap = snapshotRows(declared);
    expect(gap.rows).toStrictEqual([unbound]);
    expect(gap.mandatoryChars).toBe(JSON.stringify(declared.executionContract).length);
    expect(buildPacketManifest({ task: declared }, input).complete).toBe(false);
    for (const task of [{ executionContract: { requiredChecks: [] } }, { executionContract: {} }, {}, { executionContract: 'x' },
      { executionContract: { requiredChecks: 'x' } }, { executionContract: { requiredChecks: { length: 1 } } },
      { executionContract: Object.create({ requiredChecks: [{ id: 'unit' }] }) as object },
      Object.create({ executionContract: { requiredChecks: [{ id: 'unit' }] } }) as object]) {
      expect(snapshotRows(task).rows).toStrictEqual([]);
    }
    expect(base.rows).toStrictEqual([]);
    for (const task of [{ ...declared, requiredCheckSnapshot: { revision: 'r' } }, { requiredCheckSnapshot: { revision: 'r' } }]) {
      expect(snapshotRows(task).rows).toStrictEqual([served('task.requiredCheckSnapshot')]);
    }
  });

  describe('protected-check overlay through get_context', () => {
    const CHECKED = { ...CONTRACT, requiredChecks: [{ id: 'unit', command: 'npm test', scripts: ['scripts/check.sh'] }] };
    const snapshotFor = (defs: Parameters<typeof definitionDigest>[0]) => ({
      version: 1, revision: 'a'.repeat(40), definitionDigest: definitionDigest(defs),
      entries: [{ path: 'scripts/check.sh', oid: 'b'.repeat(40) }],
    });
    const ROW = 'task.requiredCheckSnapshot';
    const stale = snapshotFor([{ id: 'other', command: 'npm run other', scripts: ['scripts/other.sh'] }] as never);

    it.each([['absent', undefined], ['bound to other definitions', stale]])(
      'lists a declared but unserved overlay (%s) missing for every caller, never role-trimmed', async (_name, snapshot) => {
        await seed({ executionContract: CHECKED, ...(snapshot ? { requiredCheckSnapshot: snapshot } : {}) } as Partial<Task>);
        for (const workerId of ['worker-w', 'qa-q', 'architect-a', 'governor-g', '']) {
          const res = await read({ workerId });
          expect(res.task).not.toHaveProperty('requiredCheckSnapshot');
          expect(res.packetManifest.sections.filter((s) => s.path === ROW)).toStrictEqual([missing(ROW, 'unbound-snapshot')]);
          expect(res.packetManifest.complete).toBe(false);
        }
      });

    it('serves a bound overlay whole, listed served and mandatory in both views for every caller', async () => {
      const defs = validateExecutionContract(CHECKED)!.requiredChecks!;
      const snapshot = snapshotFor(defs);
      await seed({ executionContract: CHECKED, requiredCheckSnapshot: snapshot } as Partial<Task>);
      for (const workerId of ['worker-w', 'qa-q', 'architect-a', 'governor-g', '']) {
        for (const view of ['default', 'full'] as const) {
          const res = await read({ workerId, ...(view === 'full' ? { view } : {}) });
          expect((res.task as Task).requiredCheckSnapshot).toStrictEqual(snapshot);
          expect(res.packetManifest.sections.filter((s) => s.path === ROW)).toStrictEqual([served(ROW)]);
          expect(res.packetManifest.budget.mandatoryChars).toBe(charsOf(res, [...MANDATORY, ROW]));
        }
      }
    });
  });

  it('serves an unreadable planRevision as null with a limitation, never throwing', async () => {
    await seed({ planRevision: -1 } as Partial<Task>);
    const { packetManifest } = await read({ workerId: 'architect-a' });
    expect(packetManifest.provenance.task).toStrictEqual({ id: 'task-1', planRevision: null });
    expect(packetManifest.limitations).toStrictEqual(['no-repository-source', 'plan-revision-unreadable']);
  });

  it('answers a mandatory overflow with expand and never truncates', async () => {
    const task = await seed({ description: 'x'.repeat(3000) });
    const res = await read({ workerId: 'worker-w', packetBudgetChars: 1000 });
    expect(res.packetManifest.budget).toStrictEqual(
      { limitChars: 1000, mandatoryChars: charsOf(res, MANDATORY), status: 'overflow', requirement: 'expand' });
    for (const p of MANDATORY) expect(at(res, p)).toStrictEqual(at(source(task), p));
  });

  it('answers a contract no budget can hold with restructure, still served whole', async () => {
    const task = await seed({ implementationPlan: Array.from({ length: 30 }, (_, i) => step(i + 1, 'y'.repeat(9000))) });
    const res = await read({ workerId: 'worker-w', packetBudgetChars: MAX_PACKET_BUDGET_CHARS });
    expect(res.packetManifest.budget).toStrictEqual({ limitChars: MAX_PACKET_BUDGET_CHARS,
      mandatoryChars: charsOf(res, MANDATORY), status: 'overflow', requirement: 'restructure' });
    expect(res.packetManifest.budget.mandatoryChars).toBeGreaterThan(MAX_PACKET_BUDGET_CHARS);
    expect(at(res, 'task.implementationPlan')).toStrictEqual(task.implementationPlan);
  });

  it.each([0, -1, 1.5, '100', null, 999, MAX_PACKET_BUDGET_CHARS + 1])(
    'refuses packetBudgetChars %s before any write in every view', async (value) => {
      await seed({ contextFetchedBy: [] });
      const spies = [vi.spyOn(h.state, 'updateTask'), vi.spyOn(h.state, 'touchWorker'), vi.spyOn(h.state, 'writeEntity')];
      for (const view of [undefined, 'full', 'status']) {
        await expect(read({ workerId: 'worker-w', packetBudgetChars: value, ...(view ? { view } : {}) }))
          .rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field: 'packetBudgetChars' } });
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(h.state.getTask('task-1')!.contextFetchedBy).toStrictEqual([]);
    });

  it('never grants approval: a recorded read digests the manifest and strict start_step still refuses', async () => {
    await seed({ planRevision: 4, approvedPlanRevision: 3, executionPolicySnapshot: STRICT } as Partial<Task>);
    const attempt = await openAttempt(h.state, { taskId: 'task-1', workerId: 'worker-w', runnerId: 'runner-w', workspace: h.testDir });
    const { servedContext, ...packet } = await read({ workerId: 'worker-w', sessionId: SESSION });
    expect(servedContext).toMatchObject({ receiptStatus: 'recorded', planRevision: 4, approvedPlanRevision: 3 });
    expect(Object.keys(packet.packetManifest).sort())
      .toStrictEqual(['budget', 'complete', 'limitations', 'provenance', 'sections', 'version']);
    expect(JSON.stringify(packet.packetManifest)).not.toMatch(/approv|authori|ready/i);
    expect(servedContext.packetId).toBe(sha(JSON.stringify(packet)));
    expect(h.state.getTask('task-1')).toMatchObject({ planRevision: 4, approvedPlanRevision: 3 });
    await expect(startStepTool(h.state).handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-w',
      attemptId: attempt.id, generation: attempt.generation, sessionId: SESSION }, h.state))
      .rejects.toMatchObject({ codeName: 'PLAN_REVISION_NOT_APPROVED' });
  });

  it('leaves view:"status" and the task-less read without a manifest', async () => {
    await seed();
    expect(await read({ workerId: 'worker-w', view: 'status' })).not.toHaveProperty('packetManifest');
    expect(await getContextTool(h.state).handler({ workerId: 'architect-a' }, h.state)).not.toHaveProperty('packetManifest');
  });
});

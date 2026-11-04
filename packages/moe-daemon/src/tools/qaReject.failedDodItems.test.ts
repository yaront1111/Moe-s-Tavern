// qa_reject validates every failedDodItems entry before any write
// (task-c46d54a8, ported from hunt #10's zzHuntB_failedDodItems.test.ts).
// (r1)-(r5) fail on the pre-fix qaReject.ts; (c1)/(c2) pass before and after.
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { qaRejectTool } from './qaReject.js';
import { submitPlanCritiqueTool } from './submitPlanCritique.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';

describe('qa_reject failedDodItems entries', () => {
  const h = new ToolTestHarness();
  const taskFile = () => path.join(h.moePath, 'tasks', 'task-r.json');
  const reviewsDir = () => path.join(h.moePath, 'reviews');

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 } as never);
    h.createEpic();
    h.createTask({
      id: 'task-r', status: 'REVIEW', assignedWorkerId: 'qa-a', contextFetchedBy: ['qa-a'],
      definitionOfDone: ['Tests pass', 'Docs updated'],
    });
    h.createTask({ id: 'task-p', status: 'AWAITING_APPROVAL' });
    h.createWorker({ id: 'qa-a', status: 'CODING', currentTaskId: 'task-r' });
    await h.state.load();
  });
  afterEach(async () => {
    await flushActivityLog(h.state);
    h.cleanup();
  });

  const reject = (failedDodItems: unknown) => qaRejectTool(h.state).handler(
    { taskId: 'task-r', workerId: 'qa-a', reason: 'DoD item 2 is not met', failedDodItems }, h.state);
  const reviewCount = () => (fs.existsSync(reviewsDir()) ? fs.readdirSync(reviewsDir()).length : 0);

  it('(c1) control: submit_plan_critique refuses a non-string concern and bounds each at 1000 chars', async () => {
    await expect(submitPlanCritiqueTool(h.state).handler(
      { taskId: 'task-p', workerId: 'governor-g1', verdict: 'pass', concerns: [2] }, h.state))
      .rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    await submitPlanCritiqueTool(h.state).handler(
      { taskId: 'task-p', workerId: 'governor-g1', verdict: 'pass', concerns: ['c'.repeat(5000)] }, h.state);
    expect(h.state.getTask('task-p')!.planCritiqueResult!.concerns![0].length).toBe(1000);
  });

  it('(r1) refuses a non-string entry (a DoD index) with a coded INVALID_INPUT', async () => {
    await expect(reject([2])).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
  });

  it('(r2) never stores an entry longer than a DoD item (1000 chars)', async () => {
    await reject(['x'.repeat(100_000)]).catch(() => undefined);
    const t = h.state.getTask('task-r')!;
    const longest = (xs: string[] | undefined) => Math.max(0, ...(xs ?? []).map((s) => s.length));
    const stored = {
      rejectionDetails: longest(t.rejectionDetails?.failedDodItems),
      rejectionHistory: longest(t.rejectionHistory?.[0]?.failedDodItems),
      failedDodItemsLog: longest((t.failedDodItems ?? []).map((e) => e.item)),
    };
    expect(Object.entries(stored).filter(([, chars]) => chars > 1000)).toEqual([]);
  });

  it.each([
    ['r3', 'a bare string instead of an array', 'Tests pass'],
    ['r4', 'a null entry', [null]],
    ['r5', 'a 1001-char entry', ['y'.repeat(1001)]],
  ] as Array<[string, string, unknown]>)('(%s) refuses %s with INVALID_INPUT and writes nothing', async (_id, _what, value) => {
    const before = fs.readFileSync(taskFile(), 'utf8');
    const err = await reject(value).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoeError);
    expect((err as MoeError).code).toBe(MoeErrorCode.INVALID_INPUT);
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(before);
    expect(h.state.getTask('task-r')!.status).toBe('REVIEW');
    expect(reviewCount()).toBe(0);
  });

  it('(c2) control: an entry of exactly 1000 chars is accepted and stored as given', async () => {
    const item = 'z'.repeat(1000);
    await reject([item]);
    const t = h.state.getTask('task-r')!;
    expect(t.status).toBe('WORKING');
    expect(t.rejectionDetails?.failedDodItems).toEqual([item]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Task, TaskExecutionContract } from '../types/schema.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { getContextTool } from '../tools/getContext.js';
import { MoeErrorCode } from '../util/errors.js';
import * as validators from './validators.js';

const FIELDS = ['intendedBehavior', 'acceptanceCriteria', 'invariants', 'compatibility',
  'approvedScope', 'reuse', 'sourceAssumptions', 'checkRefs'] as const;
const fullContract = (): TaskExecutionContract => ({
  intendedBehavior: '  שלום\n中文 😀  ', acceptanceCriteria: ['criterion\nobservable'],
  invariants: ['preserved', 'preserved'], compatibility: ['legacy wire'],
  approvedScope: ['producer -> consumer'], reuse: ['existing helper'],
  sourceAssumptions: ['src/helper.ts: helper'], checkRefs: ['npm test'],
});

const h = new ToolTestHarness();
beforeEach(() => h.init());
afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });
async function boot(overrides: Partial<Task> = {}, requiredPatterns: string[] = []): Promise<void> {
  h.setupMoeFolder({ globalRails: { techStack: [], forbiddenPatterns: ['rm -rf'], requiredPatterns,
    formatting: '', testing: '', customRules: [] } });
  h.createEpic();
  h.createWorker({ currentTaskId: 'task-1', status: 'CODING' });
  h.createTask({ status: 'PLANNING', assignedWorkerId: 'worker-1', contextFetchedBy: ['worker-1'],
    planRevision: 7, implementationPlan: [{ stepId: 'step-1', description: 'original',
      status: 'PENDING', affectedFiles: ['file.ts'] }], ...overrides });
  await h.state.load();
}
const bytes = () => fs.readFileSync(path.join(h.moePath, 'tasks/task-1.json'), 'utf8');
const current = () => structuredClone(h.state.getTask('task-1')!);
const update = (patch: Partial<Task>) => h.state.runExclusive(() => h.state.updateTask('task-1', patch));
const submit = (extra: Record<string, unknown> = {}) => submitPlanTool(h.state).handler({
  taskId: 'task-1', workerId: 'worker-1', steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }], ...extra,
}, h.state);
const patchContract = (executionContract: unknown) => update({ executionContract } as Partial<Task>);
async function persisted(revision: number, contract?: unknown): Promise<void> {
  const disk = JSON.parse(bytes()) as Task;
  for (const task of [current(), disk]) {
    expect(task.planRevision).toBe(revision);
    expect(task.executionContract).toStrictEqual(contract);
  }
  if (contract === undefined) expect(Object.keys(disk)).not.toContain('executionContract');
  else expect(Object.keys(disk.executionContract!)).toStrictEqual(Object.keys(contract as object));
  await h.state.load();
  expect(current().executionContract).toStrictEqual(contract);
  expect(current().planRevision).toBe(revision);
}

describe('executionContract persistence and planRevision', () => {
  it('keeps legacy title updates contract-less', async () => {
    await boot(); await update({ title: 'renamed' }); await persisted(7);
  });
  it('persists canonical additions and ignores reordered board echoes', async () => {
    await boot(); await patchContract(reversed(fullContract())); await persisted(8, fullContract());
    await update({ ...current(), executionContract: reversed(fullContract()) });
    await persisted(8, fullContract());
  });
  it.each(FIELDS)('revises a change to %s exactly once', async field => {
    await boot({ executionContract: fullContract() });
    const changed = { ...fullContract(), [field]: field === 'intendedBehavior' ? 'changed' : ['changed'] };
    await patchContract(changed); await persisted(8, changed);
  });
  it('revises combined contract, DoD and step changes once', async () => {
    await boot();
    await update({ executionContract: fullContract(), definitionOfDone: ['changed'],
      implementationPlan: [{ ...current().implementationPlan[0], description: 'changed' }] });
    await persisted(8, fullContract());
  });
  it('serializes simultaneous submission and board-style writes with one bump each', async () => {
    await boot();
    const replacement = { intendedBehavior: 'board update' };
    const [submission, board] = await Promise.all([
      submit({ executionContract: fullContract() }), patchContract(replacement),
    ]);
    expect(submission).toMatchObject({ planRevision: 8 });
    expect(board.planRevision).toBe(9);
    await persisted(9, replacement);
  });
  it.each([null, undefined, {}])('clears with %j and omits the key on disk', async value => {
    await boot({ executionContract: fullContract() });
    await patchContract(value);
    expect(h.state.getTask('task-1')!.executionContract).toBeUndefined();
    await persisted(8);
    await patchContract(value); await persisted(8);
  });
  it('preserves contract bytes on metadata updates', async () => {
    await boot({ executionContract: fullContract() });
    await update({ title: 'new', priority: 'HIGH' }); await persisted(7, fullContract());
  });
  it.each([{ unknown: 'bad' }, { invariants: ['x'.repeat(1001)] }])('refuses malformed patches atomically', async value => {
    await boot(); const before = current(); const disk = bytes(); const listener = vi.fn();
    const unsubscribe = h.state.subscribe(listener);
    await expect(patchContract(value)).rejects.toMatchObject(invalid('unknown' in value ? 'unknown' : 'executionContract.invariants[0]'));
    expect(current()).toStrictEqual(before); expect(bytes()).toBe(disk);
    expect(listener).not.toHaveBeenCalled(); unsubscribe();
  });
  it('publishes nothing on disk failure and retries with one increment', async () => {
    await boot(); const before = current(); const disk = bytes(); const listener = vi.fn();
    const unsubscribe = h.state.subscribe(listener);
    vi.spyOn(h.state, 'writeEntity').mockRejectedValueOnce(new Error('disk full'));
    await expect(patchContract(fullContract())).rejects.toThrow('disk full');
    expect(current()).toStrictEqual(before); expect(bytes()).toBe(disk);
    expect(listener).not.toHaveBeenCalled(); unsubscribe();
    await patchContract(fullContract()); await persisted(8, fullContract());
  });
  it.each(['corrupt', { unknown: 'bad' }])('leaves corrupt stored input alone until replaced', async value => {
    await boot({ executionContract: value } as unknown as Partial<Task>);
    await update({ title: 'new' }); await persisted(7, value);
    await patchContract(fullContract()); await persisted(8, fullContract());
  });
});
const reversed = (value: TaskExecutionContract) => Object.fromEntries(Object.entries(value).reverse());
const invalid = (field: string) => ({ code: MoeErrorCode.INVALID_INPUT, codeName: 'INVALID_INPUT', context: expect.objectContaining({ field }) });

describe('validateExecutionContract', () => {
  it.each([undefined, null, {}, { invariants: [], checkRefs: null }])('omits empty input %j', value => {
    expect(validators.validateExecutionContract(value)).toBeUndefined();
  });
  it('canonicalizes all fields without changing Unicode, whitespace, newlines or duplicates', () => {
    const expected = fullContract();
    const input = reversed(structuredClone(expected));
    const actual = validators.validateExecutionContract(input);
    expect(actual).toStrictEqual(expected);
    expect(Object.keys(actual!)).toStrictEqual([...FIELDS]);
    expect(actual).not.toBe(input);
    (input.invariants as string[]).push('changed');
    input.intendedBehavior = 'changed';
    expect(actual).toStrictEqual(expected);
  });
  it('accepts exact boundaries unchanged', () => {
    const value = { intendedBehavior: 'x'.repeat(2000), invariants: Array(50).fill('x'.repeat(1000)) };
    expect(validators.validateExecutionContract(value)).toStrictEqual(value);
    expect([validators.MAX_CONTRACT_BEHAVIOR_CHARS, validators.MAX_CONTRACT_LIST_ITEMS,
      validators.MAX_CONTRACT_ITEM_CHARS]).toStrictEqual([2000, 50, 1000]);
  });
  it.each([
    [[], 'executionContract'], ['text', 'executionContract'], [42, 'executionContract'],
    [{ invariant: [] }, 'invariant'], [{ constructor: 'bad' }, 'constructor'],
    [{ invariants: 'text' }, 'executionContract.invariants'],
    [{ invariants: [42] }, 'executionContract.invariants[0]'],
    [{ invariants: ['   '] }, 'executionContract.invariants[0]'],
    [{ intendedBehavior: ' ' }, 'executionContract.intendedBehavior'],
    [{ invariants: ['x\u0000y'] }, 'executionContract.invariants[0]'],
    [{ intendedBehavior: 'x'.repeat(2001) }, 'executionContract.intendedBehavior'],
    [{ invariants: ['x'.repeat(1001)] }, 'executionContract.invariants[0]'],
    [{ invariants: Array(51).fill('x') }, 'executionContract.invariants'],
  ])('refuses invalid input %j at %s without truncation', (value, field) => {
    expect(() => validators.validateExecutionContract(value)).toThrowError(expect.objectContaining(invalid(field as string)));
  });
  it('shares the exact ordered allowlist', () => {
    expect(validators.EXECUTION_CONTRACT_FIELDS).toStrictEqual([...FIELDS, 'requiredChecks']);
  });
  it('reports a custom dotted field path', () => {
    expect(() => validators.validateExecutionContract({ checkRefs: [null] }, 'custom'))
      .toThrowError(expect.objectContaining(invalid('custom.checkRefs[0]')));
  });
  it('refuses sparse list slots rather than persisting null holes', () => {
    expect(() => validators.validateExecutionContract({ invariants: Array(1) }))
      .toThrowError(expect.objectContaining(invalid('executionContract.invariants[0]')));
  });
});

describe('submit_plan execution contract', () => {
  it('submits the full canonical contract with one durable revision', async () => {
    await boot();
    const result = await submit({ executionContract: reversed(fullContract()) });
    expect(result).toMatchObject({ success: true, status: 'AWAITING_APPROVAL', planRevision: 8 });
    expect(current().status).toBe('AWAITING_APPROVAL');
    await persisted(8, fullContract());
  });
  it('leaves legacy submissions without even an own undefined key', async () => {
    await boot(); await submit();
    expect(Object.keys(current())).not.toContain('executionContract');
    await persisted(8);
  });
  it('replaces a stored contract with none when omitted', async () => {
    await boot({ executionContract: fullContract() }); await submit(); await persisted(8);
  });
  it.each([
    [{ unknown: true }, 'unknown'], [{ invariants: Array(51).fill('x') }, 'executionContract.invariants'],
    ['text', 'executionContract'],
  ])('refuses malformed contract without writing task or worker', async (value, field) => {
    await boot(); const disk = bytes(); const before = current();
    const worker = structuredClone(h.state.getWorker('worker-1'));
    const workerPath = path.join(h.moePath, 'workers/worker-1.json');
    const workerDisk = fs.readFileSync(workerPath, 'utf8');
    await expect(submit({ executionContract: value })).rejects.toMatchObject(invalid(field as string));
    expect(bytes()).toBe(disk); expect(current()).toStrictEqual(before);
    expect(h.state.getWorker('worker-1')).toStrictEqual(worker);
    expect(fs.readFileSync(workerPath, 'utf8')).toBe(workerDisk);
  });
  it.each(FIELDS)('refuses forbidden patterns appearing only in contract.%s', async field => {
    await boot(); const disk = bytes();
    const value = { [field]: field === 'intendedBehavior' ? 'rm -rf' : ['rm -rf'] };
    await expect(submit({ executionContract: value })).rejects.toMatchObject({ codeName: 'CONSTRAINT_VIOLATION' });
    expect(bytes()).toBe(disk);
  });
  it('does not let contract text satisfy required step patterns', async () => {
    await boot({}, ['error handling']); const disk = bytes();
    await expect(submit({ executionContract: { invariants: ['error handling'] } }))
      .rejects.toMatchObject({ codeName: 'CONSTRAINT_VIOLATION', message: expect.stringContaining('Required pattern missing') });
    expect(bytes()).toBe(disk);
  });
  it('does not require step patterns again in the contract', async () => {
    await boot({}, ['error handling']);
    await submit({ steps: [{ description: 'test error handling', affectedFiles: ['file.ts'] }], executionContract: fullContract() });
    await persisted(8, fullContract());
  });
  it('exposes schema properties matching the strict validator', () => {
    const properties = submitPlanTool(h.state).inputSchema.properties as Record<string, { properties: object; additionalProperties: boolean }>;
    expect(properties.executionContract).toBeDefined();
    expect(Object.keys(properties.executionContract.properties)).toStrictEqual(validators.EXECUTION_CONTRACT_FIELDS);
    expect(properties.executionContract.additionalProperties).toBe(false);
  });
});

const context = async (workerId: string, view?: 'full' | 'status') =>
  await getContextTool(h.state).handler({ taskId: 'task-1', workerId, view }, h.state) as {
    task: { executionContract?: TaskExecutionContract }; omitted?: string[];
  };
const roles = [['worker-1', undefined], ['qa-1', undefined], ['architect-1', undefined], ['qa-1', 'full']] as const;
describe('get_context execution contract', () => {
  it.each(roles)('serves mandatory contract to %s (view %s), including after reload', async (role, view) => {
    await boot(); await submit({ executionContract: reversed(fullContract()) });
    for (let reload = 0; reload < 2; reload++) {
      const result = await context(role, view);
      expect(result.task.executionContract).toStrictEqual(fullContract());
      expect(result.omitted ?? []).not.toContain('executionContract');
      expect(result.omitted ?? []).not.toContain('task.executionContract');
      await h.state.load();
    }
  });
  it.each(roles)('omits legacy contract for %s (view %s)', async (role, view) => {
    await boot();
    expect(Object.keys((await context(role, view)).task)).not.toContain('executionContract');
  });
  it('omits a cleared contract before and after reload and excludes status view', async () => {
    await boot({ executionContract: fullContract() });
    expect(Object.keys((await context('worker-1', 'status')).task)).not.toContain('executionContract');
    await patchContract(null);
    expect(Object.keys((await context('qa-1')).task)).not.toContain('executionContract');
    await h.state.load();
    expect(Object.keys((await context('qa-1')).task)).not.toContain('executionContract');
  });
  it.each(['corrupt', { unknown: 'bad' }])('serves corrupt stored data without validation or throwing', async value => {
    await boot({ executionContract: value } as unknown as Partial<Task>);
    expect((await context('qa-1')).task.executionContract).toStrictEqual(value);
  });
});

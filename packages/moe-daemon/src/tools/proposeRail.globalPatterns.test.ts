// GLOBAL MODIFY_RAIL / REMOVE_RAIL reach the two lists submit_plan enforces
// (forbiddenPatterns, requiredPatterns) as well as customRules (task-34e42a0a).
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { proposeRailTool } from './proposeRail.js';
import { submitPlanTool } from './submitPlan.js';
import { MoeError } from '../util/errors.js';

const RAILS = {
  techStack: [], formatting: '', testing: '',
  forbiddenPatterns: ['rm -rf', 'console.log'],
  requiredPatterns: ['error handling', 'test'],
  customRules: ['Keep it simple'],
};

describe('moe.propose_rail GLOBAL rail lists (task-34e42a0a)', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ globalRails: structuredClone(RAILS) });
    h.createEpic();
    h.createTask({ status: 'PLANNING', assignedWorkerId: 'architect-1' });
    await h.state.load();
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const plan = (description: string) => ({ taskId: 'task-1', workerId: 'architect-1', steps: [{ description, affectedFiles: ['file.ts'] }] });
  const FORBIDDEN_PLAN = plan('Replace the console.log call with the logger, with error handling and a test');
  const REQUIRED_PLAN = plan('Rename a constant and add a test');
  const submit = (p: object) => submitPlanTool(h.state).handler(p, h.state);
  const propose = (args: Record<string, unknown>) => proposeRailTool(h.state).handler({
    taskId: 'task-1', targetScope: 'GLOBAL', proposedValue: '', reason: 'the rail is wrong for this task', workerId: 'architect-1', ...args,
  }, h.state) as Promise<{ proposalId: string; status: string }>;
  const diskRails = () => (JSON.parse(fs.readFileSync(path.join(h.moePath, 'project.json'), 'utf-8')) as { globalRails: typeof RAILS }).globalRails;
  const proposalFiles = () => fs.readdirSync(path.join(h.moePath, 'proposals'));

  it.each([
    ['(g1) REMOVE a forbiddenPatterns entry', 'REMOVE_RAIL', 'console.log', '', FORBIDDEN_PLAN, 'Forbidden pattern: console.log', { forbiddenPatterns: ['rm -rf'] }],
    ['(g2) MODIFY a forbiddenPatterns entry', 'MODIFY_RAIL', 'console.log', 'console.debug', FORBIDDEN_PLAN, 'Forbidden pattern: console.log', { forbiddenPatterns: ['rm -rf', 'console.debug'] }],
    ['(g3) REMOVE a requiredPatterns entry', 'REMOVE_RAIL', 'error handling', '', REQUIRED_PLAN, 'Required pattern missing: error handling', { requiredPatterns: ['test'] }],
    ['(g4) MODIFY a requiredPatterns entry', 'MODIFY_RAIL', 'error handling', 'constant', REQUIRED_PLAN, 'Required pattern missing: error handling', { requiredPatterns: ['constant', 'test'] }],
  ] as const)('%s: PENDING, approval edits exactly that entry on disk, and the refused plan is accepted', async (_title, proposalType, currentValue, proposedValue, refusedPlan, violation, changed) => {
    const { proposalId, status } = await propose({ proposalType, currentValue, proposedValue });
    expect(status).toBe('PENDING');
    await expect(submit(refusedPlan)).rejects.toThrow(violation);

    await h.state.approveProposal(proposalId);
    await h.state.load();
    const expected = { ...RAILS, ...changed };
    expect(h.state.project!.globalRails).toEqual(expected);
    expect(diskRails()).toEqual(expected);
    expect(h.state.proposals.get(proposalId)!.status).toBe('APPROVED');

    await submit(refusedPlan);
    expect(h.state.getTask('task-1')!.status).toBe('AWAITING_APPROVAL');
  });

  it('(g5) a GLOBAL value in no rail list is a coded NOT_FOUND refusal that writes nothing', async () => {
    const err = await propose({ proposalType: 'REMOVE_RAIL', currentValue: 'no such rail' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoeError);
    expect(err).toMatchObject({ codeName: 'NOT_FOUND' });
    expect((err as Error).message).toContain('Rail not found');
    expect(h.state.proposals.size).toBe(0);
    expect(proposalFiles()).toEqual([]);
  });

  it('(g6) a GLOBAL value in two rail lists is a coded INVALID_INPUT refusal that writes nothing', async () => {
    h.state.project!.globalRails.customRules = ['console.log'];
    const err = await propose({ proposalType: 'MODIFY_RAIL', currentValue: 'console.log', proposedValue: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoeError);
    expect(err).toMatchObject({ codeName: 'INVALID_INPUT' });
    expect((err as Error).message).toContain('Ambiguous rail match');
    expect(h.state.proposals.size).toBe(0);
    expect(proposalFiles()).toEqual([]);
  });

  it('(g7) approval re-resolves: a value gone since the proposal is a coded refusal that changes nothing', async () => {
    const { proposalId } = await propose({ proposalType: 'REMOVE_RAIL', currentValue: 'console.log' });
    h.state.project!.globalRails.forbiddenPatterns = ['rm -rf'];
    const before = fs.readFileSync(path.join(h.moePath, 'project.json'), 'utf-8');
    await expect(h.state.approveProposal(proposalId)).rejects.toMatchObject({ codeName: 'NOT_FOUND' });
    expect(fs.readFileSync(path.join(h.moePath, 'project.json'), 'utf-8')).toBe(before);
    expect(h.state.proposals.get(proposalId)!.status).toBe('PENDING');
  });

  it('(g8) GLOBAL ADD_RAIL still appends to customRules only', async () => {
    const { proposalId } = await propose({ proposalType: 'ADD_RAIL', proposedValue: 'console.log' });
    await h.state.approveProposal(proposalId);
    await h.state.load();
    expect(h.state.project!.globalRails).toEqual({ ...RAILS, customRules: ['Keep it simple', 'console.log'] });
  });
});

import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { proposeRailTool } from './proposeRail.js';

describe('moe.propose_rail', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ assignedWorkerId: 'worker-1' });
    await h.state.load();
  });

  it('creates a rail proposal', async () => {
    const tool = proposeRailTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      proposalType: 'ADD_RAIL',
      targetScope: 'GLOBAL',
      proposedValue: 'always use async/await',
      reason: 'Improves readability',
    }, h.state) as { success: boolean; proposalId: string; status: string };

    expect(result.success).toBe(true);
    expect(result.proposalId).toMatch(/^prop-/);
    expect(result.status).toBe('PENDING');

    expect(h.state.proposals.size).toBe(1);
  });

  it('throws for non-existent task', async () => {
    const tool = proposeRailTool(h.state);
    await expect(
      tool.handler({
        taskId: 'nonexistent',
        proposalType: 'ADD_RAIL',
        targetScope: 'TASK',
        proposedValue: 'test',
        reason: 'test',
      }, h.state)
    ).rejects.toThrow('Task not found');
  });

  it('includes workerId from assigned task', async () => {
    await h.state.updateEpic('epic-1', { epicRails: ['old value '] });
    const tool = proposeRailTool(h.state);
    await tool.handler({
      taskId: 'task-1',
      proposalType: 'MODIFY_RAIL',
      targetScope: 'EPIC',
      currentValue: 'old value',
      proposedValue: 'new value',
      reason: 'Better approach',
    }, h.state);

    const proposal = Array.from(h.state.proposals.values())[0];
    expect(proposal.workerId).toBe('worker-1');
    expect(proposal.currentValue).toBe('old value');
  });

  it('refuses a modification whose original rail does not exist', async () => {
    const tool = proposeRailTool(h.state);
    await expect(tool.handler({
      taskId: 'task-1',
      proposalType: 'MODIFY_RAIL',
      targetScope: 'GLOBAL',
      currentValue: 'old value',
      proposedValue: 'new value',
      reason: 'Replace the old rail',
    }, h.state)).rejects.toThrow('Rail not found');
    expect(h.state.proposals.size).toBe(0);
  });

  it('refuses removal without an original rail value', async () => {
    const tool = proposeRailTool(h.state);
    await expect(tool.handler({
      taskId: 'task-1',
      proposalType: 'REMOVE_RAIL',
      targetScope: 'TASK',
      proposedValue: '',
      reason: 'Remove the old rail',
    }, h.state)).rejects.toThrow('currentValue');
    expect(h.state.proposals.size).toBe(0);
  });

  describe('lossless epic rail boundary', () => {
    const LIMIT = 1000;
    const propose = (args: Record<string, unknown>) => proposeRailTool(h.state).handler({
      taskId: 'task-1',
      targetScope: 'EPIC',
      reason: 'Keep the approved constraint exact',
      ...args,
    }, h.state);
    const epicFile = () => fs.readFileSync(path.join(h.moePath, 'epics', 'epic-1.json'), 'utf-8');
    const proposalFiles = () => fs.readdirSync(path.join(h.moePath, 'proposals')).sort();
    const snapshot = () => JSON.stringify({
      proposals: Array.from(h.state.proposals.values()),
      proposalFiles: proposalFiles(),
      epic: h.state.getEpic('epic-1'),
      epicFile: epicFile(),
    });
    const watchEvents = () => {
      const types: string[] = [];
      h.state.subscribe((event) => { types.push(event.type); });
      return types;
    };
    const oversizedPending = async (overrides: Record<string, unknown> = {}) => h.state.createProposal({
      id: 'prop-legacy-oversized',
      workerId: 'worker-1',
      taskId: 'task-1',
      proposalType: 'ADD_RAIL',
      targetScope: 'EPIC',
      currentValue: null,
      proposedValue: 'x'.repeat(LIMIT + 1),
      reason: 'Persisted before the length check existed',
      status: 'PENDING',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    });

    it.each(['ADD_RAIL', 'MODIFY_RAIL'] as const)('refuses a %s over 1000 characters before any write', async (proposalType) => {
      await h.state.updateEpic('epic-1', { epicRails: ['old value'] });
      const events = watchEvents();
      const before = snapshot();

      await expect(propose({
        proposalType,
        currentValue: proposalType === 'MODIFY_RAIL' ? 'old value' : undefined,
        proposedValue: 'x'.repeat(LIMIT + 1),
      })).rejects.toMatchObject({
        codeName: 'INVALID_INPUT',
        context: { field: 'proposedValue' },
      });

      expect(snapshot()).toBe(before);
      expect(h.state.proposals.size).toBe(0);
      expect(events).toEqual([]);
    });

    it('treats the limit as UTF-16 code units, so a split surrogate pair is over', async () => {
      const pair = '\u{1F512}';
      await expect(propose({ proposalType: 'ADD_RAIL', proposedValue: 'x'.repeat(LIMIT - 1) + pair }))
        .rejects.toMatchObject({ codeName: 'INVALID_INPUT' });
      expect(h.state.proposals.size).toBe(0);
    });

    it.each(['ADD_RAIL', 'MODIFY_RAIL'] as const)('keeps a 1000-character %s exact through approval and reload', async (proposalType) => {
      const old = ' leading and trailing space ';
      await h.state.updateEpic('epic-1', { epicRails: [old, 'neighbour'] });
      const rail = ' é中' + 'x'.repeat(LIMIT - 6) + '\u{1F512} ';
      expect(rail.length).toBe(LIMIT);
      const { proposalId } = await propose({
        proposalType,
        currentValue: proposalType === 'MODIFY_RAIL' ? old : undefined,
        proposedValue: rail,
      }) as { proposalId: string };
      expect(h.state.proposals.get(proposalId)!.proposedValue).toBe(rail);

      await h.state.approveProposal(proposalId);
      const expected = proposalType === 'ADD_RAIL' ? [old, 'neighbour', rail] : [rail, 'neighbour'];
      expect(h.state.getEpic('epic-1')!.epicRails).toEqual(expected);

      await h.state.load();
      expect(h.state.getEpic('epic-1')!.epicRails).toEqual(expected);
      expect((JSON.parse(epicFile()) as { epicRails: string[] }).epicRails).toEqual(expected);
      expect(h.state.proposals.get(proposalId)!.status).toBe('APPROVED');
    });

    it('accepts a 999-character rail unchanged', async () => {
      const rail = 'x'.repeat(LIMIT - 1);
      const { proposalId } = await propose({ proposalType: 'ADD_RAIL', proposedValue: rail }) as { proposalId: string };
      await h.state.approveProposal(proposalId);
      expect(h.state.getEpic('epic-1')!.epicRails).toEqual([rail]);
    });

    it('lets a stored over-long rail be shortened or removed but blocks other rail changes meanwhile', async () => {
      const legacy = 'L'.repeat(LIMIT + 50);
      const stored = JSON.parse(epicFile()) as Record<string, unknown>;
      fs.writeFileSync(path.join(h.moePath, 'epics', 'epic-1.json'), JSON.stringify({ ...stored, epicRails: [legacy, 'other'] }, null, 2));
      await h.state.load();

      const add = await propose({ proposalType: 'ADD_RAIL', proposedValue: 'new rail' }) as { proposalId: string };
      await expect(h.state.approveProposal(add.proposalId)).rejects.toMatchObject({ context: { field: 'epicRails[0]' } });
      expect(h.state.proposals.get(add.proposalId)!.status).toBe('PENDING');
      expect(h.state.getEpic('epic-1')!.epicRails).toEqual([legacy, 'other']);

      const shorten = await propose({ proposalType: 'MODIFY_RAIL', currentValue: legacy, proposedValue: 'short' }) as { proposalId: string };
      await h.state.approveProposal(shorten.proposalId);
      await h.state.approveProposal(add.proposalId);
      expect(h.state.getEpic('epic-1')!.epicRails).toEqual(['short', 'other', 'new rail']);
    });

    it('rejects approval of a legacy oversized pending proposal without mutating anything', async () => {
      await h.state.updateEpic('epic-1', { epicRails: ['kept'] });
      await oversizedPending();
      const events = watchEvents();
      const before = snapshot();

      await expect(h.state.approveProposal('prop-legacy-oversized')).rejects.toMatchObject({ codeName: 'INVALID_INPUT' });

      expect(h.state.proposals.get('prop-legacy-oversized')!.status).toBe('PENDING');
      expect(snapshot()).toBe(before);
      expect(events).not.toContain('PROPOSAL_APPROVED');
      expect(events).not.toContain('PROPOSAL_UPDATED');
      expect(events).not.toContain('EPIC_UPDATED');
    });

    it('keeps the proposal pending when the first epic write fails', async () => {
      const { proposalId } = await propose({ proposalType: 'ADD_RAIL', proposedValue: 'valid rail' }) as { proposalId: string };
      const before = snapshot();
      vi.spyOn(h.state, 'writeEntity').mockRejectedValueOnce(new Error('disk full'));

      await expect(h.state.approveProposal(proposalId)).rejects.toThrow('disk full');

      expect(h.state.proposals.get(proposalId)!.status).toBe('PENDING');
      expect(snapshot()).toBe(before);
    });

    it('fails a direct update atomically when any rail is oversized', async () => {
      await h.state.updateEpic('epic-1', { epicRails: ['original'] });
      const before = snapshot();

      await expect(h.state.updateEpic('epic-1', { epicRails: ['valid first', 'x'.repeat(LIMIT + 1)] }))
        .rejects.toMatchObject({ context: { field: 'epicRails[1]' } });

      expect(snapshot()).toBe(before);
      const exact = 'z'.repeat(LIMIT);
      await h.state.updateEpic('epic-1', { epicRails: [exact] });
      expect(h.state.getEpic('epic-1')!.epicRails).toEqual([exact]);
    });

    it.each([
      ['a non-string', 42],
      ['a blank string', '   '],
      ['a NUL character', 'bad\u0000rail'],
      ['a newline', 'bad\nrail'],
    ])('fails a direct update atomically for %s', async (_label, bad) => {
      await h.state.updateEpic('epic-1', { epicRails: ['original'] });
      const before = snapshot();

      await expect(h.state.updateEpic('epic-1', { epicRails: ['valid first', bad as string] }))
        .rejects.toMatchObject({ codeName: 'INVALID_INPUT' });

      expect(snapshot()).toBe(before);
    });

    it('does not cap GLOBAL or TASK rails or the current value of a removal', async () => {
      const long = 'g'.repeat(LIMIT * 3);
      for (const targetScope of ['GLOBAL', 'TASK'] as const) {
        const { proposalId } = await propose({ proposalType: 'ADD_RAIL', targetScope, proposedValue: long }) as { proposalId: string };
        expect(h.state.proposals.get(proposalId)!.proposedValue).toBe(long);
        await h.state.approveProposal(proposalId);
      }
      expect(h.state.project!.globalRails.customRules).toEqual([long]);
      expect(h.state.getTask('task-1')!.taskRails).toEqual([long]);

      // A rail that predates the cap stays removable: only a replacement is bounded.
      const legacy = fs.readFileSync(path.join(h.moePath, 'epics', 'epic-1.json'), 'utf-8');
      fs.writeFileSync(path.join(h.moePath, 'epics', 'epic-1.json'),
        legacy.replace('"epicRails": []', `"epicRails": ["${'L'.repeat(LIMIT + 50)}"]`));
      await h.state.load();
      const { proposalId } = await propose({
        proposalType: 'REMOVE_RAIL',
        currentValue: 'L'.repeat(LIMIT + 50),
        proposedValue: '',
      }) as { proposalId: string };
      await h.state.approveProposal(proposalId);
      expect(h.state.getEpic('epic-1')!.epicRails).toEqual([]);
    });
  });
});


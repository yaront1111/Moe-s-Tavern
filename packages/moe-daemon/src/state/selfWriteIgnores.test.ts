import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from './StateManager.js';
import type { FileWatcher } from './FileWatcher.js';

// project.json, pins/ and decisions/ are watched. A daemon write there that does
// not register its FileWatcher ignore first comes back as an external change,
// and every such echo reloads the whole state.
describe('daemon writes to watched paths register their FileWatcher ignore', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  let ignored: string[];
  let general: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-selfwrite-ignores-'));
    moePath = path.join(testDir, '.moe');
    for (const dir of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
      fs.mkdirSync(path.join(moePath, dir), { recursive: true });
    }
    const now = new Date().toISOString();
    // Minimal on purpose: load() fills in the defaults and writes the result back.
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test',
      name: 'Ignore Project',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'CONTROL', agentCommand: 'claude' },
      createdAt: now,
      updatedAt: now,
    }));
    ignored = [];
    state = new StateManager({ projectPath: testDir });
    state.setFileWatcher({ ignorePath: (filePath: string) => { ignored.push(filePath); } } as unknown as FileWatcher);
    await state.load();
    general = state.getChannels().find((channel) => channel.name === 'general')!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const projectFile = (): string => path.join(moePath, 'project.json');
  const ignoresOf = (filePath: string): number => ignored.filter((entry) => entry === filePath).length;

  it('load() writing back a normalized project.json', () => {
    expect(ignoresOf(projectFile())).toBe(1);
  });

  it('a settings update', async () => {
    ignored = [];
    await state.updateSettings({ speedModeDelayMs: 1500 });
    expect(ignoresOf(projectFile())).toBe(1);
  });

  it('an approved global rail', async () => {
    const now = new Date().toISOString();
    const proposal = await state.createProposal({
      id: 'proposal-global', workerId: 'worker-1', taskId: 'task-none', proposalType: 'ADD_RAIL', targetScope: 'GLOBAL',
      currentValue: null, proposedValue: 'Always add regression tests', reason: 'test', status: 'PENDING',
      resolvedAt: null, resolvedBy: null, createdAt: now,
    });
    ignored = [];
    await state.approveProposal(proposal.id);
    expect(ignoresOf(projectFile())).toBe(1);
  });

  it('a pin and an unpin', async () => {
    const { message } = await state.sendMessage({ channel: general, sender: 'human', content: 'pin me' });
    const pinsFile = path.join(moePath, 'pins', `${general}.json`);
    ignored = [];
    await state.pinMessage(general, message.id, 'human');
    expect(ignoresOf(pinsFile)).toBe(1);
    await state.unpinMessage(general, message.id);
    expect(ignoresOf(pinsFile)).toBe(2);
  });

  it('a decision proposed in a channel, then approved, and one rejected', async () => {
    const decisionFile = (id: string): string => path.join(moePath, 'decisions', `${id}.json`);
    const approved = await state.createDecision({ content: 'ship it', proposedBy: 'human', channel: general });
    // The record, then its re-write carrying the posted line's messageId.
    expect(ignoresOf(decisionFile(approved.id))).toBe(2);
    await state.approveDecision(approved.id, 'human');
    expect(ignoresOf(decisionFile(approved.id))).toBe(3);

    const rejected = await state.createDecision({ content: 'hold it', proposedBy: 'human' });
    expect(ignoresOf(decisionFile(rejected.id))).toBe(1);
    await state.rejectDecision(rejected.id);
    expect(ignoresOf(decisionFile(rejected.id))).toBe(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { enterGovernanceTool } from './enterGovernance.js';
import type { Project, Epic, Worker } from '../types/schema.js';

describe('moe.enter_governance', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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

  function writeWorker(overrides: Partial<Worker> = {}): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id: 'architect-1', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', worker.id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-enter-gov-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    writeEpic();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('throws notFound for unknown workerId', async () => {
    await state.load();
    const tool = enterGovernanceTool(state);
    await expect(tool.handler({ workerId: 'ghost' }, state))
      .rejects.toThrow(/not found|NOT_FOUND/i);
  });

  it('sets worker to GOVERNING, returns chat_wait nextAction with discovered channels', async () => {
    writeWorker({ id: 'architect-1', status: 'IDLE', currentTaskId: null });
    await state.load();

    // Create the four channels the architect should watch.
    await state.createChannel({ name: 'general', type: 'general' });
    const arch = await state.createChannel({ name: 'architects', type: 'role' });
    const wrk = await state.createChannel({ name: 'workers', type: 'role' });
    const qa = await state.createChannel({ name: 'qa', type: 'role' });

    const tool = enterGovernanceTool(state);
    const result = await tool.handler({ workerId: 'architect-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('GOVERNING');
    expect(state.getWorker('architect-1')!.status).toBe('GOVERNING');
    expect(state.getWorker('architect-1')!.currentTaskId).toBeNull();

    const channelEntries = result.channels as { id: string; name: string }[];
    const names = channelEntries.map((c) => c.name).sort();
    expect(names).toEqual(['architects', 'general', 'qa', 'workers']);

    const next = result.nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.tool).toBe('moe.chat_wait');
    expect(next.args.workerId).toBe('architect-1');
    const channelIds = next.args.channels as string[];
    expect(channelIds).toContain(arch.id);
    expect(channelIds).toContain(wrk.id);
    expect(channelIds).toContain(qa.id);
  });

  it('succeeds even when no role channels exist (empty channel list)', async () => {
    writeWorker({ id: 'architect-1' });
    await state.load();

    const tool = enterGovernanceTool(state);
    const result = await tool.handler({ workerId: 'architect-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect((result.channels as unknown[]).length).toBe(0);
    expect(state.getWorker('architect-1')!.status).toBe('GOVERNING');
  });

  it('rejects missing workerId', async () => {
    await state.load();
    const tool = enterGovernanceTool(state);
    await expect(tool.handler({}, state)).rejects.toThrow(/workerId/);
  });
});

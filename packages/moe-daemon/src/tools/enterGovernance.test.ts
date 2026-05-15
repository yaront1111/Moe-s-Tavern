import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { enterGovernanceTool } from './enterGovernance.js';
import type { Project, Epic, Worker, TeamRole } from '../types/schema.js';

describe('moe.enter_governance', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
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
      id: 'governor-1', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', worker.id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  async function bindWorkerToTeamRole(workerId: string, role: TeamRole): Promise<void> {
    const team = await state.createTeam({ name: `${role}s`, role });
    await state.addTeamMember(team.id, workerId);
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

  it('rejects architect (or any non-governor worker) with NOT_ALLOWED', async () => {
    writeWorker({ id: 'architect-1', status: 'IDLE' });
    await state.load();
    await bindWorkerToTeamRole('architect-1', 'architect');

    const tool = enterGovernanceTool(state);
    await expect(tool.handler({ workerId: 'architect-1' }, state))
      .rejects.toThrow(/governor-only|NOT_ALLOWED/i);
    // Worker status should NOT have been mutated.
    expect(state.getWorker('architect-1')!.status).toBe('IDLE');
  });

  it('rejects a worker without any team (defensive)', async () => {
    writeWorker({ id: 'orphan-1', status: 'IDLE', teamId: null });
    await state.load();

    const tool = enterGovernanceTool(state);
    await expect(tool.handler({ workerId: 'orphan-1' }, state))
      .rejects.toThrow(/governor-only|NOT_ALLOWED/i);
  });

  it('sets governor worker to GOVERNING and returns chat_wait nextAction', async () => {
    writeWorker({ id: 'governor-1', status: 'IDLE', currentTaskId: null });
    await state.load();
    await bindWorkerToTeamRole('governor-1', 'governor');

    // Create the five channels the governor should watch.
    await state.createChannel({ name: 'general', type: 'general' });
    const arch = await state.createChannel({ name: 'architects', type: 'role' });
    const wrk = await state.createChannel({ name: 'workers', type: 'role' });
    const qa = await state.createChannel({ name: 'qa', type: 'role' });
    const gov = await state.createChannel({ name: 'governors', type: 'role' });

    const tool = enterGovernanceTool(state);
    const result = await tool.handler({ workerId: 'governor-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('GOVERNING');
    expect(state.getWorker('governor-1')!.status).toBe('GOVERNING');
    expect(state.getWorker('governor-1')!.currentTaskId).toBeNull();

    const channelEntries = result.channels as { id: string; name: string }[];
    const names = channelEntries.map((c) => c.name).sort();
    expect(names).toEqual(['architects', 'general', 'governors', 'qa', 'workers']);

    const next = result.nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.tool).toBe('moe.chat_wait');
    expect(next.args.workerId).toBe('governor-1');
    const channelIds = next.args.channels as string[];
    expect(channelIds).toContain(arch.id);
    expect(channelIds).toContain(wrk.id);
    expect(channelIds).toContain(qa.id);
    expect(channelIds).toContain(gov.id);
  });

  it('succeeds even when no role channels exist (empty channel list)', async () => {
    writeWorker({ id: 'governor-1' });
    await state.load();
    await bindWorkerToTeamRole('governor-1', 'governor');

    const tool = enterGovernanceTool(state);
    const result = await tool.handler({ workerId: 'governor-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect((result.channels as unknown[]).length).toBe(0);
    expect(state.getWorker('governor-1')!.status).toBe('GOVERNING');
  });

  it('rejects missing workerId', async () => {
    await state.load();
    const tool = enterGovernanceTool(state);
    await expect(tool.handler({}, state)).rejects.toThrow(/workerId/);
  });
});

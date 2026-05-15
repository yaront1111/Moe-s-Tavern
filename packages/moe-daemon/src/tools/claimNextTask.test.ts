import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { claimNextTaskTool } from './claimNextTask.js';
import type { Project, Epic, Worker, TeamRole } from '../types/schema.js';

describe('moe.claim_next_task — role-aware routing', () => {
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

  function writeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  async function bindWorkerToTeamRole(workerId: string, role: TeamRole): Promise<void> {
    const team = await state.createTeam({ name: `${role}s`, role });
    await state.addTeamMember(team.id, workerId);
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claim-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    writeEpic();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('routes a governor straight to enter_governance instead of returning tasks', async () => {
    writeWorker('governor-1');
    await state.load();
    await bindWorkerToTeamRole('governor-1', 'governor');

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'governor-1', statuses: ['PLANNING', 'WORKING', 'REVIEW'] },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    const next = result.nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.tool).toBe('moe.enter_governance');
    expect(next.args.workerId).toBe('governor-1');
  });

  it('architect on empty PLANNING queue gets wait_for_task (no governance recommendation)', async () => {
    writeWorker('architect-1');
    await state.load();
    await bindWorkerToTeamRole('architect-1', 'architect');

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'architect-1', statuses: ['PLANNING'] },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    const next = result.nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.tool).toBe('moe.wait_for_task');
    // Critical regression guard: architects must never get routed to enter_governance.
    expect(next.tool).not.toBe('moe.enter_governance');
  });

  it('worker on empty WORKING queue gets wait_for_task (unchanged)', async () => {
    writeWorker('worker-1');
    await state.load();
    await bindWorkerToTeamRole('worker-1', 'worker');

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'worker-1', statuses: ['WORKING'] },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    const next = result.nextAction as { tool: string };
    expect(next.tool).toBe('moe.wait_for_task');
  });
});

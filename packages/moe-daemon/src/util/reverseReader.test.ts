import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readLastLines } from './reverseReader.js';
import { StateManager } from '../state/StateManager.js';
import { getActivityLogTool } from '../tools/getActivityLog.js';
import type { ActivityEvent } from '../types/schema.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function setupMoeFolder(testDir: string): string {
  const moePath = path.join(testDir, '.moe');
  fs.mkdirSync(moePath, { recursive: true });
  fs.mkdirSync(path.join(moePath, 'epics'));
  fs.mkdirSync(path.join(moePath, 'tasks'));
  fs.mkdirSync(path.join(moePath, 'workers'));
  fs.mkdirSync(path.join(moePath, 'proposals'));

  const now = new Date().toISOString();
  const project = {
    id: 'proj-test',
    name: 'Test Project',
    rootPath: testDir,
    globalRails: {
      techStack: [],
      forbiddenPatterns: [],
      requiredPatterns: [],
      formatting: '',
      testing: '',
      customRules: [],
    },
    settings: {
      approvalMode: 'CONTROL',
      speedModeDelayMs: 2000,
      autoCreateBranch: true,
      branchPattern: 'moe/{epicId}/{taskId}',
      commitPattern: 'feat({epicId}): {taskTitle}',
      agentCommand: 'claude',
    },
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));

  const epic = {
    id: 'epic-1',
    projectId: 'proj-test',
    title: 'Test Epic',
    description: 'Epic description',
    architectureNotes: '',
    epicRails: [],
    status: 'ACTIVE',
    order: 1,
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));

  const task = {
    id: 'task-1',
    epicId: 'epic-1',
    title: 'Task',
    description: 'Description',
    definitionOfDone: [],
    taskRails: [],
    implementationPlan: [],
    status: 'BACKLOG',
    assignedWorkerId: null,
    branch: null,
    prLink: null,
    reopenCount: 0,
    reopenReason: null,
    createdBy: 'HUMAN',
    parentTaskId: null,
    priority: 'MEDIUM',
    order: 1,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task, null, 2));

  return moePath;
}

function writeLines(filePath: string, lines: string[], trailingNewline = true): void {
  const content = trailingNewline ? `${lines.join('\n')}\n` : lines.join('\n');
  fs.writeFileSync(filePath, content, 'utf-8');
}

function createActivityEvent(index: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: `evt-${index}`,
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    projectId: 'proj-test',
    epicId: 'epic-1',
    taskId: index % 2 === 0 ? 'task-a' : 'task-b',
    payload: { index },
    event: 'TASK_UPDATED',
    ...overrides,
  };
}

describe('readLastLines', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('returns all lines for small files and keeps chronological order', () => {
    const dir = createTempDir('moe-reverse-reader-');
    const filePath = path.join(dir, 'small.log');
    writeLines(filePath, ['line-1', 'line-2', 'line-3']);

    expect(readLastLines(filePath, 10)).toEqual(['line-1', 'line-2', 'line-3']);
  });

  it('returns only the last N lines for large files', () => {
    const dir = createTempDir('moe-reverse-reader-');
    const filePath = path.join(dir, 'large.log');
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i + 1}-${'x'.repeat(40)}`);
    writeLines(filePath, lines);

    const result = readLastLines(filePath, 5);
    expect(result).toEqual(lines.slice(-5));
  });

  it('returns empty array for empty or missing files', () => {
    const dir = createTempDir('moe-reverse-reader-');
    const emptyPath = path.join(dir, 'empty.log');
    fs.writeFileSync(emptyPath, '');

    expect(readLastLines(emptyPath, 10)).toEqual([]);
    expect(readLastLines(path.join(dir, 'missing.log'), 10)).toEqual([]);
  });

  it('handles files without trailing newline', () => {
    const dir = createTempDir('moe-reverse-reader-');
    const filePath = path.join(dir, 'no-trailing-newline.log');
    writeLines(filePath, ['line-1', 'line-2', 'line-3'], false);

    expect(readLastLines(filePath, 2)).toEqual(['line-2', 'line-3']);
  });
});

describe('activity log tail integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('supports filtered getActivityLog tool queries from the tail window', async () => {
    const testDir = createTempDir('moe-activity-tail-');
    const moePath = setupMoeFolder(testDir);
    const logPath = path.join(moePath, 'activity.log');

    const events = Array.from({ length: 240 }, (_, i) =>
      createActivityEvent(i + 1, { taskId: i % 3 === 0 ? 'task-filtered' : 'task-other' })
    );
    writeLines(logPath, events.map((event) => JSON.stringify(event)));

    const state = new StateManager({ projectPath: testDir });
    await state.load();
    const tool = getActivityLogTool(state);

    const result = await tool.handler({ taskId: 'task-filtered', limit: 10 }, state) as {
      events: ActivityEvent[];
      count: number;
    };

    expect(result.count).toBeLessThanOrEqual(10);
    expect(result.events.length).toBe(result.count);
    expect(result.events.every((event) => event.taskId === 'task-filtered')).toBe(true);
  });

  it('does not full-read large activity.log files when serving tail queries', async () => {
    const testDir = createTempDir('moe-activity-tail-');
    const moePath = setupMoeFolder(testDir);
    const logPath = path.join(moePath, 'activity.log');

    const events = Array.from({ length: 400 }, (_, i) =>
      createActivityEvent(i + 1, { taskId: 'task-1', epicId: 'epic-1' })
    );
    writeLines(logPath, events.map((event) => JSON.stringify(event)));

    const state = new StateManager({ projectPath: testDir });
    await state.load();

    const originalReadFileSync = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      const target = args[0];
      if (target === logPath) {
        throw new Error('StateManager.getActivityLog should not read full activity.log');
      }
      return originalReadFileSync(...args as Parameters<typeof fs.readFileSync>);
    }) as typeof fs.readFileSync);

    const tailEvents = state.getActivityLog(25);

    expect(tailEvents).toHaveLength(25);
    expect(readSpy).not.toHaveBeenCalledWith(logPath, 'utf-8');
  });
});

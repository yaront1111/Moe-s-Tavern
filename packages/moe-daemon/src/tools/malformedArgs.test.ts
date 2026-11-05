// Malformed arguments get coded refusals, never an uncoded TypeError (which the
// MCP adapter answers as a bare -32000 "Tool failed" with no codeName). qa_reject
// called .trim() on a non-string reason or issue description and iterated a
// non-array issues; start_step, complete_step and complete_task read fields off
// the raw args, which are undefined when a tools/call omits `arguments` (the
// adapter passes them through as sent).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { qaRejectTool } from './qaReject.js';
import { startStepTool } from './startStep.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { MoeError } from '../util/errors.js';
import type { StateManager } from '../state/StateManager.js';
import type { ToolDefinition } from './index.js';

describe('malformed arguments get coded refusals', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-r', status: 'REVIEW', assignedWorkerId: 'qa-a', contextFetchedBy: ['qa-a'] });
    h.createWorker({ id: 'qa-a', status: 'CODING', currentTaskId: 'task-r' });
    await h.state.load();
  });
  afterEach(async () => {
    await flushActivityLog(h.state);
    h.cleanup();
  });

  const codeNameOf = async (call: Promise<unknown>): Promise<string | undefined> => {
    const err = await call.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(MoeError);
    return (err as MoeError).codeName;
  };

  it.each<[string, Record<string, unknown>]>([
    ['a numeric reason', { reason: 42 }],
    ['an issues object instead of an array', { reason: 'r', issues: { type: 'other', description: 'x' } }],
    ['a null issue', { reason: 'r', issues: [null] }],
    ['a numeric issue description', { reason: 'r', issues: [{ type: 'other', description: 42 }] }],
  ])('qa_reject refuses %s with INVALID_INPUT and writes nothing', async (_what, args) => {
    const before = h.state.getTask('task-r')!.updatedAt;

    const codeName = await codeNameOf(qaRejectTool(h.state).handler({ taskId: 'task-r', workerId: 'qa-a', ...args }, h.state));

    expect(codeName).toBe('INVALID_INPUT');
    expect(h.state.getTask('task-r')).toMatchObject({ status: 'REVIEW', updatedAt: before });
  });

  it.each<[string, (state: StateManager) => ToolDefinition]>([
    ['start_step', startStepTool],
    ['complete_step', completeStepTool],
    ['complete_task', completeTaskTool],
  ])('%s called with no arguments refuses MISSING_REQUIRED', async (_name, tool) => {
    for (const args of [undefined, null]) {
      expect(await codeNameOf(tool(h.state).handler(args, h.state))).toBe('MISSING_REQUIRED');
    }
  });
});

// =============================================================================
// Tool Registry
// =============================================================================

import type { StateManager } from '../state/StateManager.js';
import { getContextTool } from './getContext.js';
import { submitPlanTool } from './submitPlan.js';
import { checkApprovalTool } from './checkApproval.js';
import { startStepTool } from './startStep.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { reportBlockedTool } from './reportBlocked.js';
import { proposeRailTool } from './proposeRail.js';
import { listTasksTool } from './listTasks.js';
import { getNextTaskTool } from './getNextTask.js';
import { createTaskTool } from './createTask.js';
import { createEpicTool } from './createEpic.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { deleteTaskTool } from './deleteTask.js';

export type ToolHandler = (args: unknown, state: StateManager) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

export function getTools(state: StateManager): ToolDefinition[] {
  return [
    getContextTool(state),
    submitPlanTool(state),
    checkApprovalTool(state),
    startStepTool(state),
    completeStepTool(state),
    completeTaskTool(state),
    reportBlockedTool(state),
    proposeRailTool(state),
    listTasksTool(state),
    getNextTaskTool(state),
    createTaskTool(state),
    createEpicTool(state),
    setTaskStatusTool(state),
    claimNextTaskTool(state),
    deleteTaskTool(state)
  ];
}

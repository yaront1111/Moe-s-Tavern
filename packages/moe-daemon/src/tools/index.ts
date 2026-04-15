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
import { updateEpicTool } from './updateEpic.js';
import { deleteEpicTool } from './deleteEpic.js';
import { searchTasksTool } from './searchTasks.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { deleteTaskTool } from './deleteTask.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { initProjectTool } from './initProject.js';
import { getActivityLogTool } from './getActivityLog.js';
import { unblockWorkerTool } from './unblockWorker.js';
import { createTeamTool } from './createTeam.js';
import { joinTeamTool } from './joinTeam.js';
import { leaveTeamTool } from './leaveTeam.js';
import { listTeamsTool } from './listTeams.js';
import { waitForTaskTool } from './waitForTask.js';
import { addCommentTool } from './addComment.js';
import { getPendingQuestionsTool } from './getPendingQuestions.js';
import { chatSendTool } from './chatSend.js';
import { chatReadTool } from './chatRead.js';
import { chatChannelsTool } from './chatChannels.js';
import { chatJoinTool } from './chatJoin.js';
import { chatWhoTool } from './chatWho.js';
import { chatWaitTool } from './chatWait.js';
import { chatResyncTool } from './chatResync.js';
import { chatPinTool } from './chatPin.js';
import { chatUnpinTool } from './chatUnpin.js';
import { chatDecisionTool } from './chatDecision.js';
import { chatCreateChannelTool } from './chatCreateChannel.js';
import { rememberTool } from './remember.js';
import { recallTool } from './recall.js';
import { reflectTool } from './reflect.js';
import { saveSessionSummaryTool } from './saveSessionSummary.js';

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
    updateEpicTool(state),
    deleteEpicTool(state),
    searchTasksTool(state),
    setTaskStatusTool(state),
    claimNextTaskTool(state),
    deleteTaskTool(state),
    qaApproveTool(state),
    qaRejectTool(state),
    initProjectTool(state),
    getActivityLogTool(state),
    unblockWorkerTool(state),
    createTeamTool(state),
    joinTeamTool(state),
    leaveTeamTool(state),
    listTeamsTool(state),
    waitForTaskTool(state),
    addCommentTool(state),
    getPendingQuestionsTool(state),
    chatSendTool(state),
    chatReadTool(state),
    chatChannelsTool(state),
    chatJoinTool(state),
    chatWhoTool(state),
    chatWaitTool(state),
    chatResyncTool(state),
    chatPinTool(state),
    chatUnpinTool(state),
    chatDecisionTool(state),
    chatCreateChannelTool(state),
    rememberTool(state),
    recallTool(state),
    reflectTool(state),
    saveSessionSummaryTool(state),
  ];
}

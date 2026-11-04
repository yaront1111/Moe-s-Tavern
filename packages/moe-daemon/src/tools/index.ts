// =============================================================================
// Tool Registry
// =============================================================================

import type { StateManager } from '../state/StateManager.js';
import type { TeamRole } from '../types/schema.js';
import { getContextTool } from './getContext.js';
import { submitPlanTool } from './submitPlan.js';
import { checkApprovalTool } from './checkApproval.js';
import { startStepTool } from './startStep.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { reportBlockedTool } from './reportBlocked.js';
import { requestReplanTool } from './requestReplan.js';
import { proposeRailTool } from './proposeRail.js';
import { listTasksTool } from './listTasks.js';
import { getNextTaskTool } from './getNextTask.js';
import { createTaskTool } from './createTask.js';
import { createEpicTool } from './createEpic.js';
import { updateEpicTool } from './updateEpic.js';
import { deleteEpicTool } from './deleteEpic.js';
import { archiveTaskTool } from './archiveTask.js';
import { archiveEpicTool } from './archiveEpic.js';
import { searchTasksTool } from './searchTasks.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { finalizeAttemptTool } from './finalizeAttempt.js';
import { reattachAttemptTool } from './reattachAttempt.js';
import { deleteTaskTool } from './deleteTask.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { initProjectTool } from './initProject.js';
import { unblockWorkerTool } from './unblockWorker.js';
import { releaseTaskTool } from './releaseTask.js';
import { enterGovernanceTool } from './enterGovernance.js';
import { listWorkersTool } from './listWorkers.js';
import { getSeatLivenessTool } from './getSeatLiveness.js';
import { getExecutionReadinessTool } from './getExecutionReadiness.js';
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
import { chatWaitTool } from './chatWait.js';
import { chatWhoTool } from './chatWho.js';
import { chatResyncTool } from './chatResync.js';
import { chatPinTool } from './chatPin.js';
import { chatUnpinTool } from './chatUnpin.js';
import { chatDecisionTool } from './chatDecision.js';
import { chatCreateChannelTool } from './chatCreateChannel.js';
import { getHandoffHistoryTool } from './getHandoffHistory.js';
import { listMetricsTool } from './listMetrics.js';
import { getActivityLogTool } from './getActivityLog.js';
import { submitPlanCritiqueTool } from './submitPlanCritique.js';
import { amendPlanStepTool } from './amendPlanStep.js';
import { deregisterWorkerTool } from './deregisterWorker.js';
import { heartbeatTool } from './heartbeat.js';
import { leaseAccountTool } from './leaseAccount.js';
import { reportAccountUsageTool } from './reportAccountUsage.js';
import { acquireResourceTool } from './acquireResource.js';
import { releaseResourceTool } from './releaseResource.js';
import { listResourcesTool } from './listResources.js';
import { waitForResourceTool } from './waitForResource.js';
import { getCommitScopeTool } from './getCommitScope.js';
import { recordCommitTool } from './recordCommit.js';
import { recordCandidateTool } from './recordCandidate.js';
import { recordCheckRunTool } from './recordCheckRun.js';
import { recordCheckDispatchTool } from './recordCheckDispatch.js';
import { recordCheckObservationTool } from './recordCheckObservation.js';
import { recordDeliveryReceiptTool } from './recordDeliveryReceipt.js';
import { declareFilesTool } from './declareFiles.js';
import { setTaskDependenciesTool } from './setTaskDependencies.js';
import { setTaskPriorityTool } from './setTaskPriority.js';

export interface ToolCallContext {
  /** Connection lifetime check for asynchronous setup before a long poll parks. */
  shouldContinue?: () => boolean;
  /** Called synchronously after a long poll publishes its active waiter. */
  onWaiterRegistered?: (workerId: string) => void;
  /** Set only by an authenticated /runner connection (server/runnerChannel.ts), never from arguments. */
  runner?: { readonly runnerId: string };
}

export type ToolHandler = (args: unknown, state: StateManager, context?: ToolCallContext) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  /**
   * When true, the MCP dispatch layer does NOT wrap this tool in the global
   * state mutex. Long waits (wait_for_task, chat_wait) and bounded read-only
   * subprocess preflights (submit_plan) opt out so they cannot freeze the fleet.
   * Mutating handlers that opt out must serialize and revalidate their writes. All other tools are serialized to prevent lost updates from
   * concurrent read-modify-write on the same entity.
   */
  blocking?: boolean;
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
    requestReplanTool(state),
    proposeRailTool(state),
    listTasksTool(state),
    getNextTaskTool(state),
    createTaskTool(state),
    createEpicTool(state),
    updateEpicTool(state),
    deleteEpicTool(state),
    searchTasksTool(state),
    setTaskStatusTool(state),
    archiveTaskTool(state),
    archiveEpicTool(state),
    claimNextTaskTool(state),
    finalizeAttemptTool(state),
    reattachAttemptTool(state),
    deleteTaskTool(state),
    qaApproveTool(state),
    qaRejectTool(state),
    initProjectTool(state),
    unblockWorkerTool(state),
    releaseTaskTool(state),
    enterGovernanceTool(state),
    listWorkersTool(state),
    getSeatLivenessTool(state),
    getExecutionReadinessTool(state),
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
    chatWaitTool(state),
    chatWhoTool(state),
    chatResyncTool(state),
    chatPinTool(state),
    chatUnpinTool(state),
    chatDecisionTool(state),
    chatCreateChannelTool(state),
    getHandoffHistoryTool(state),
    listMetricsTool(state),
    getActivityLogTool(state),
    submitPlanCritiqueTool(state),
    amendPlanStepTool(state),
    deregisterWorkerTool(state),
    heartbeatTool(state),
    leaseAccountTool(state),
    reportAccountUsageTool(state),
    acquireResourceTool(state),
    releaseResourceTool(state),
    listResourcesTool(state),
    waitForResourceTool(state),
    getCommitScopeTool(state),
    recordCommitTool(state),
    recordCandidateTool(state),
    recordCheckRunTool(state),
    recordCheckDispatchTool(state),
    recordCheckObservationTool(state),
    recordDeliveryReceiptTool(state),
    declareFilesTool(state),
    setTaskDependenciesTool(state),
    setTaskPriorityTool(state),
  ];
}

type Seat = Exclude<TeamRole, 'governor'>;
const A: Seat = 'architect', W: Seat = 'worker', Q: Seat = 'qa';
const ALL: readonly Seat[] = [A, W, Q];

/**
 * Who sees each tool in tools/list. A role sees a tool when its role doc,
 * .reference.md, a skill it loads, the launcher prompt or a nextAction aimed at
 * it names the tool; when unsure it is included. The governor sees every
 * agent-facing tool; 'wrapper' tools are called only by the launcher scripts
 * (via tools/call, which is never filtered). A tool missing here is visible to all.
 */
export const TOOL_AUDIENCE: Readonly<Record<string, readonly Seat[] | 'wrapper'>> = {
  'moe.get_context': ALL,
  'moe.submit_plan': [A, W],
  'moe.check_approval': [A, W],
  'moe.start_step': [W],
  'moe.complete_step': [W],
  'moe.complete_task': [W],
  'moe.report_blocked': ALL,
  'moe.request_replan': ALL,
  'moe.propose_rail': [A, W],
  'moe.list_tasks': ALL,
  'moe.get_next_task': [A],
  'moe.create_task': ALL,
  'moe.create_epic': [A],
  'moe.update_epic': [A],
  'moe.delete_epic': [A],
  'moe.search_tasks': ALL,
  'moe.set_task_status': [A],
  'moe.archive_task': [A],
  'moe.archive_epic': [A],
  'moe.claim_next_task': ALL,
  'moe.finalize_attempt': [],
  'moe.reattach_attempt': 'wrapper',
  'moe.delete_task': [A],
  'moe.qa_approve': [Q],
  'moe.qa_reject': [Q],
  'moe.init_project': [],
  'moe.unblock_worker': [],
  'moe.release_task': [],
  'moe.enter_governance': [],
  'moe.list_workers': ALL,
  'moe.create_team': [],
  'moe.join_team': [],
  'moe.leave_team': [],
  'moe.list_teams': [],
  'moe.wait_for_task': ALL,
  'moe.add_comment': ALL,
  'moe.get_pending_questions': ALL,
  'moe.chat_send': ALL,
  'moe.chat_read': ALL,
  'moe.chat_channels': ALL,
  'moe.chat_join': ALL,
  'moe.chat_wait': ALL,
  'moe.chat_who': ALL,
  'moe.chat_resync': ALL,
  'moe.chat_pin': [],
  'moe.chat_unpin': [],
  'moe.chat_decision': ALL,
  'moe.chat_create_channel': [A],
  'moe.get_handoff_history': ALL,
  'moe.list_metrics': [],
  'moe.get_activity_log': [A],
  'moe.submit_plan_critique': [],
  'moe.amend_plan_step': [A],
  'moe.deregister_worker': 'wrapper',
  'moe.heartbeat': 'wrapper',
  'moe.get_seat_liveness': 'wrapper',
  'moe.get_execution_readiness': 'wrapper',
  'moe.lease_account': 'wrapper',
  'moe.report_account_usage': 'wrapper',
  'moe.acquire_resource': [W, Q],
  'moe.release_resource': [W, Q],
  'moe.list_resources': [W, Q],
  'moe.wait_for_resource': [W, Q],
  'moe.get_commit_scope': 'wrapper',
  'moe.record_commit': [W, Q],
  'moe.record_candidate': 'wrapper',
  'moe.record_check_run': [W, Q],
  'moe.record_check_dispatch': 'wrapper',
  'moe.record_check_observation': 'wrapper',
  'moe.record_delivery_receipt': 'wrapper',
  'moe.declare_files': [W],
  'moe.set_task_dependencies': [A],
  'moe.set_task_priority': [],
};

/** The tools/list a caller of this role should see. No role (IDE, moe-call.sh, humans) → every tool. */
export function toolsForRole<T extends { name: string }>(tools: readonly T[], role: TeamRole | null | undefined): T[] {
  if (!role) return [...tools];
  return tools.filter((tool) => {
    const audience = TOOL_AUDIENCE[tool.name];
    if (audience === undefined) return true;
    if (audience === 'wrapper') return false;
    return role === 'governor' || audience.includes(role);
  });
}

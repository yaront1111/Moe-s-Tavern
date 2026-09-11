package com.moe.model

/**
 * Largest plan revision that survives a round trip through the daemon's JSON
 * numbers, i.e. `Number.MAX_SAFE_INTEGER`. Anything above it cannot be trusted
 * to mean what the daemon sent, so it is rejected rather than truncated.
 */
const val MAX_SAFE_PLAN_REVISION: Long = 9007199254740991L

data class MoeState(
    val project: Project,
    val epics: List<Epic>,
    val tasks: List<Task>,
    val proposals: List<RailProposal> = emptyList(),
    val workers: List<Worker> = emptyList(),
    val teams: List<Team> = emptyList(),
    val channels: List<ChatChannel> = emptyList()
)

data class Project(
    val id: String,
    val name: String,
    val rootPath: String = "",
    val settings: ProjectSettings? = null
)

/**
 * The plugin's parsed view of `.moe/project.json` `settings`.
 *
 * Every default here must track the daemon, which applies its own defaults at
 * read time rather than at init: the landing booleans come from the `policy`
 * block of `packages/moe-daemon/src/tools/getCommitScope.ts` (`!== false` for
 * [autoCommit]/[checkpointCommits]/[checkpointPush]/[commitBoardState], `=== true`
 * for [commitHooks], `?? 'solo'` for [attributionUndeclared]), [qualityGateScope]
 * falls back to `epicFinal` in `scripts/moe-agent.sh`, and [taskSizing] mirrors
 * `packages/moe-daemon/src/util/planSize.ts`. A snapshot missing a key must still
 * construct a valid object, so no field is nullable without a default.
 *
 * `autoCreateBranch`, `branchPattern` and `commitPattern` are deliberately absent:
 * they are inert legacy keys that no longer affect landing. No wrapper creates a
 * branch per task (they peel onto [consolidationBranch] else the shared
 * `moe/work-<YYYY-MM-DD>`) and no commit subject derives from `commitPattern`.
 * The daemon still accepts and stores them, so existing project.json files load.
 */
data class ProjectSettings(
    val approvalMode: String = "CONTROL",
    val speedModeDelayMs: Int = 2000,
    val agentCommand: String = "claude",
    val enableAgentTeams: Boolean = false,
    val columnLimits: Map<String, Int>? = null,
    val autoCommit: Boolean = true,
    val checkpointCommits: Boolean = true,
    val checkpointPush: Boolean = true,
    val commitBoardState: Boolean = true,
    val commitHooks: Boolean = false,
    val consolidationBranch: String = "",
    val qualityGate: String = "",
    val qualityGateScope: String = "epicFinal",
    val attributionUndeclared: String = "solo",
    val taskSizing: TaskSizingThresholds = TaskSizingThresholds()
)

/** Plan-size bands from `settings.taskSizing`; defaults mirror `util/planSize.ts`. */
data class TaskSizingThresholds(
    val warnSteps: Int = 8,
    val maxSteps: Int = 12,
    val warnDistinctFiles: Int = 5,
    val maxDistinctFiles: Int = 10
)

data class Epic(
    val id: String,
    val title: String,
    val description: String,
    val architectureNotes: String,
    val epicRails: List<String>,
    val status: String,
    val order: Double,
    val createdAt: String = "",
    val updatedAt: String = ""
)

data class TaskComment(
    val id: String,
    val author: String,
    val content: String,
    val timestamp: String
)

data class ImplementationStep(
    val stepId: String,
    val description: String,
    val status: String,
    val affectedFiles: List<String>,
    val modifiedFiles: List<String>? = null,
    val note: String? = null,
    val startedAt: String? = null,
    val completedAt: String? = null
)

data class TaskMetrics(
    val plannedStepCount: Int? = null,
    val plannedDistinctFileCount: Int? = null,
    val executedStepCount: Int? = null,
    val reopenCount: Int? = null,
    val rejectCount: Int? = null,
    val wallClockMs: Long? = null,
    val firstClaimAt: String? = null,
    val doneAt: String? = null
)

// Verification evidence submitted with moe.complete_task (worker's fresh run
// of the plan-named verification command). exitCode is always 0 when present —
// the daemon rejects non-zero — but kept nullable for forward compat.
data class TaskVerification(
    val command: String,
    val exitCode: Int? = null,
    val outputTail: String? = null,
    val reportedAt: String? = null
)

data class HandoffNote(
    val from: String? = null,
    val to: String? = null,
    val createdAt: String? = null,
    val whatIsDone: String? = null,
    val whatRemains: String? = null,
    val pitfalls: String? = null,
    val openQuestions: String? = null
)

data class FailedDodItem(
    val item: String,
    val rejectedAt: String? = null,
    val rejectedBy: String? = null
)

data class PlanCritiqueResult(
    val verdict: String,
    val concerns: List<String>? = null,
    val reviewedBy: String? = null,
    val reviewedAt: String? = null
)

data class Task(
    val id: String,
    val epicId: String,
    val title: String,
    val description: String,
    val status: String,
    val priority: String = "MEDIUM",
    val order: Double,
    val definitionOfDone: List<String>,
    val implementationPlan: List<ImplementationStep>,
    val prLink: String?,
    val reopenReason: String?,
    val assignedWorkerId: String?,
    val comments: List<TaskComment>? = null,
    val hasPendingQuestion: Boolean = false,
    // Runtime-driven workflow state (schema additions from Phase 3):
    // workers who have fetched context (ordering check for start_step)
    val contextFetchedBy: List<String>? = null,
    // stepIds already completed (cross-check for complete_task)
    val stepsCompleted: List<String>? = null,
    val reopenCount: Int = 0,
    val taskRails: List<String>? = null,
    // Schema additions for the metrics surface (rendered when present)
    val metrics: TaskMetrics? = null,
    val priorHandoffs: List<HandoffNote>? = null,
    val failedDodItems: List<FailedDodItem>? = null,
    val planCritiqueResult: PlanCritiqueResult? = null,
    // Warn-zone size warnings from the latest submit_plan (cleared by a
    // compliant resubmit) — rendered as an amber chip on the board card.
    val planSizeWarnings: List<String>? = null,
    // complete_task verification evidence + qa_approve summary (audit trail).
    val verification: TaskVerification? = null,
    val reviewSummary: String? = null,
    // Daemon blocker/attention metadata, display data only: kept exactly as sent,
    // never inferred from status. needsHumanReview is independent of BLOCKED.
    val needsHumanReview: Boolean = false,
    val blockedReason: String? = null,
    val blockedOnTaskIds: List<String>? = null,
    val blockedResourceId: String? = null,
    val blockedFromStatus: String? = null,
    val blockedAt: String? = null,
    // Revision of the plan the daemon currently holds, used to prove an approval
    // reviewed THIS plan. Two absent-looking cases are deliberately distinct:
    // a daemon payload with no field at all is a legacy task, effective 0; a
    // present but malformed field parses to null — unusable, and a reviewing UI
    // must refuse it rather than approve against an assumed 0.
    val planRevision: Long? = 0L
)

// Aggregates returned by the daemon's moe.list_metrics tool.
data class MetricsAggregate(
    val firstPassApprovalPct: Double? = null,
    val avgWallClockMs: Long? = null,
    val avgReopenCount: Double? = null,
    val totalCompleted: Int? = null,
    val perEpic: List<EpicMetricsAggregate> = emptyList()
)

data class EpicMetricsAggregate(
    val epicId: String,
    val epicTitle: String? = null,
    val completed: Int = 0,
    val avgReopenCount: Double? = null,
    val avgWallClockMs: Long? = null
)

data class DaemonInfo(
    val port: Int,
    val pid: Int,
    val startedAt: String,
    val projectPath: String
)

data class ActivityEvent(
    val id: String,
    val timestamp: String,
    val projectId: String,
    val epicId: String?,
    val taskId: String?,
    val workerId: String?,
    val event: String,
    val payload: Map<String, Any?>
)

data class RailProposal(
    val id: String,
    val workerId: String,
    val taskId: String,
    val proposalType: String,
    val targetScope: String,
    val currentValue: String?,
    val proposedValue: String,
    val reason: String,
    val status: String,
    val createdAt: String
)

data class Worker(
    val id: String,
    val type: String,
    val epicId: String,
    val currentTaskId: String?,
    val status: String,
    val lastError: String?,
    val teamId: String? = null
)

data class Team(
    val id: String,
    val name: String,
    val role: String,
    val memberIds: List<String>,
    val maxSize: Int = 10
)

data class ChatChannel(
    val id: String,
    val name: String,
    val type: String,
    val linkedEntityId: String? = null,
    val createdAt: String = ""
)

data class ChatMessage(
    val id: String,
    val channel: String,
    val sender: String,
    val content: String,
    val replyTo: String? = null,
    val mentions: List<String> = emptyList(),
    val timestamp: String = "",
    val decisionId: String? = null
)

data class PinEntry(
    val messageId: String,
    val pinnedBy: String,
    val pinnedAt: String,
    val done: Boolean,
    val doneAt: String? = null
)

data class Decision(
    val id: String,
    val proposedBy: String,
    val content: String,
    val status: String,
    val approvedBy: String? = null,
    val channel: String? = null,
    val messageId: String? = null,
    val createdAt: String = "",
    val resolvedAt: String? = null
)

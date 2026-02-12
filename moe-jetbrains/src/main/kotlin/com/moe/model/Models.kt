package com.moe.model

data class MoeState(
    val project: Project,
    val epics: List<Epic>,
    val tasks: List<Task>,
    val proposals: List<RailProposal> = emptyList(),
    val workers: List<Worker> = emptyList(),
    val teams: List<Team> = emptyList()
)

data class Project(
    val id: String,
    val name: String,
    val settings: ProjectSettings? = null
)

data class ProjectSettings(
    val approvalMode: String = "CONTROL",
    val speedModeDelayMs: Int = 2000,
    val autoCreateBranch: Boolean = true,
    val branchPattern: String = "moe/{epicId}/{taskId}",
    val commitPattern: String = "feat({epicId}): {taskTitle}",
    val agentCommand: String = "claude",
    val columnLimits: Map<String, Int>? = null
)

data class Epic(
    val id: String,
    val title: String,
    val description: String,
    val architectureNotes: String,
    val epicRails: List<String>,
    val status: String,
    val order: Double
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
    val affectedFiles: List<String>
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
    val hasPendingQuestion: Boolean = false
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

package com.moe.model

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

data class ProjectSettings(
    val approvalMode: String = "CONTROL",
    val speedModeDelayMs: Int = 2000,
    val autoCreateBranch: Boolean = true,
    val branchPattern: String = "moe/{epicId}/{taskId}",
    val commitPattern: String = "feat({epicId}): {taskTitle}",
    val agentCommand: String = "claude",
    val enableAgentTeams: Boolean = false,
    val columnLimits: Map<String, Int>? = null
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

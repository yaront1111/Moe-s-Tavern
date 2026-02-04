package com.moe.model

data class MoeState(
    val project: Project,
    val epics: List<Epic>,
    val tasks: List<Task>,
    val proposals: List<RailProposal> = emptyList()
)

data class Project(
    val id: String,
    val name: String
)

data class Epic(
    val id: String,
    val title: String,
    val description: String,
    val status: String,
    val order: Double
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
    val order: Double,
    val definitionOfDone: List<String>,
    val implementationPlan: List<ImplementationStep>,
    val prLink: String?,
    val reopenReason: String?,
    val assignedWorkerId: String?
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

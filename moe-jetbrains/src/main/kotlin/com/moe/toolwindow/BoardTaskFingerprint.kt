package com.moe.toolwindow

import com.moe.model.Task

/**
 * Cache key for the tasks a board or column rendered. A plan edit can change
 * only the plan revision or only step text, so both are part of the key: a
 * stale snapshot would hand the daemon an old revision that its CAS refuses.
 * A null (malformed) revision is kept distinct from a legacy 0.
 */
internal fun boardTaskFingerprint(tasks: List<Task>): String = tasks.joinToString(",") {
    val stepFp = it.implementationPlan.joinToString(";") { s -> "${s.stepId}:${s.status}:${s.description}" }
    "${it.id}:${it.status}:${it.order}:${it.title}:${it.description}:${it.priority}:${it.assignedWorkerId ?: ""}:${it.prLink ?: ""}:${it.reopenReason ?: ""}:${it.comments?.size ?: 0}:${it.hasPendingQuestion}:rev=${it.planRevision}:[$stepFp]"
}

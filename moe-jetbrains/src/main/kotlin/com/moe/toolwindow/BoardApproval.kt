package com.moe.toolwindow

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.moe.model.Task
import com.moe.services.MoeNotificationService
import com.moe.services.MoeProjectService
import com.moe.toolwindow.PlanReviewApprovalState.Decision
import com.moe.toolwindow.PlanReviewApprovalState.RevisionToken
import com.moe.util.MoeBundle
import javax.swing.SwingUtilities

object BoardApproval {
    /**
     * Quotes only the snapshot the caller rendered, never a fresher cached task.
     * Callers must retain that rendered snapshot until the gesture is handled.
     * Missing tasks, changed statuses and unusable stamps fail closed.
     */
    fun decide(task: Task?): Decision {
        if (task == null) return Decision.Blocked(PlanReviewApprovalState.TASK_MISSING_KEY)
        if (task.status != PlanReviewApprovalState.STATUS_AWAITING_APPROVAL) {
            return Decision.Blocked(PlanReviewApprovalState.STATUS_CHANGED_KEY)
        }
        return when (val token = PlanReviewApprovalState.tokenOf(task.planRevision)) {
            is RevisionToken.Present -> Decision.Send(task.id, token.value)
            RevisionToken.LegacyMissing -> Decision.Send(task.id, PlanReviewApprovalState.LEGACY_EFFECTIVE_REVISION)
            RevisionToken.Malformed -> Decision.Blocked(PlanReviewApprovalState.REVISION_UNUSABLE_KEY)
        }
    }

    /** EDT-only UI adapter; a local send is never treated as daemon approval. */
    fun approveRendered(project: Project, service: MoeProjectService, task: Task?) {
        check(SwingUtilities.isEventDispatchThread()) { "Board approval must run on the EDT" }
        dispatch(decide(task),
            { id, revision -> service.approveTask(id, revision) },
            { key -> MoeNotificationService.getInstance(project).notifyApprovalBlocked(task, MoeBundle.message(key)) })
    }

    /** Separate transport effects from IntelliJ UI so failure paths stay headless-testable. */
    internal fun dispatch(decision: Decision, send: (String, Long) -> Boolean, blocked: (String) -> Unit) {
        when (decision) {
            is Decision.Blocked -> blocked(decision.messageKey)
            is Decision.Send -> try {
                // A false result already triggers the sender's disconnected notice.
                send(decision.taskId, decision.expectedPlanRevision)
            } catch (ex: Exception) {
                Logger.getInstance(BoardApproval::class.java).warn("Failed to send the plan approval", ex)
                blocked(PlanReviewApprovalState.SEND_FAILED_KEY)
            }
        }
    }
}

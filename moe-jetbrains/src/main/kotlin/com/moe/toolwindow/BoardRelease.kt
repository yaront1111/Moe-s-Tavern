package com.moe.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.moe.model.Task
import com.moe.services.MoeProjectService
import com.moe.util.MoeBundle
import javax.swing.SwingUtilities

/**
 * Release Agent, shared by the board card menu and Task Detail.
 *
 * The daemon's /ws RELEASE_TASK refuses a task whose holder is mid-step
 * (STEP_LEASE_HELD) unless the frame carries force:true, and its ERROR frame
 * names no task, so a refusal cannot be matched back to a click. The plugin
 * therefore decides from the rendered task before sending, and asks a second,
 * explicit question before it ever sends force.
 */
object BoardRelease {
    private const val IN_PROGRESS = "IN_PROGRESS"
    internal const val FORCE_MESSAGE_KEY = "moe.message.releaseAgentForce"
    internal const val FORCE_TITLE_KEY = "moe.message.releaseAgentForceTitle"
    internal const val STALE_MESSAGE_KEY = "moe.message.releaseAgentForceStale"

    /** The step lease that makes the daemon refuse a release sent without force. */
    data class StepLease(val holder: String, val stepId: String)

    /** What one Release Agent gesture did. */
    enum class Outcome {
        /** No frame: nothing to release, or the user declined a confirmation. */
        CANCELLED,
        /** The plain frame {taskId, reason}, exactly as before force existed. */
        RELEASED,
        /** The frame with force:true, sent after the second confirmation. */
        FORCE_RELEASED,
        /** No frame: force was confirmed, but the cached task no longer shows that lease. */
        STALE
    }

    /**
     * Mirrors packages/moe-daemon/src/util/claimGuards.ts assertNoLiveLease for a
     * caller with no workerId, which is the /ws path: a task with a non-empty
     * assignedWorkerId and an IN_PROGRESS step is leased by that assignee on the
     * first such step (inProgressStep uses find). Null for a missing task, an
     * unassigned one, or a plan with no IN_PROGRESS step: a plain release passes.
     */
    fun stepLease(task: Task?): StepLease? {
        if (task == null) return null
        val holder = task.assignedWorkerId
        if (holder.isNullOrEmpty()) return null
        val step = task.implementationPlan.firstOrNull { it.status == IN_PROGRESS } ?: return null
        return StepLease(holder, step.stepId)
    }

    /**
     * The gesture without IntelliJ UI, so every path is headless-testable.
     * [rendered] is the snapshot the user clicked, and it alone decides force.
     * [latest] reads the newest cached copy only to refuse a force whose
     * confirmed lease is gone (a stale dialog must never force-release a
     * different live seat). It never chooses what is sent.
     */
    internal fun release(
        rendered: Task,
        confirmRelease: () -> Boolean,
        confirmForce: (StepLease) -> Boolean,
        latest: () -> Task?,
        send: (Boolean) -> Unit,
        stale: (StepLease) -> Unit
    ): Outcome {
        if (rendered.assignedWorkerId.isNullOrBlank()) return Outcome.CANCELLED
        if (!confirmRelease()) return Outcome.CANCELLED
        val lease = stepLease(rendered)
        if (lease == null) {
            send(false)
            return Outcome.RELEASED
        }
        if (!confirmForce(lease)) return Outcome.CANCELLED
        if (stepLease(latest()) != lease) {
            stale(lease)
            return Outcome.STALE
        }
        send(true)
        return Outcome.FORCE_RELEASED
    }

    /** EDT-only UI adapter used by MoeToolWindowPanel.handleReleaseAgent and TaskDetailDialog. */
    fun releaseRendered(project: Project, service: MoeProjectService, task: Task): Outcome {
        check(SwingUtilities.isEventDispatchThread()) { "Board release must run on the EDT" }
        return release(
            task,
            confirmRelease = {
                Messages.showYesNoDialog(
                    project,
                    MoeBundle.message("moe.message.releaseAgent", task.assignedWorkerId ?: "", task.title),
                    MoeBundle.message("moe.message.releaseAgentTitle"),
                    Messages.getQuestionIcon()
                ) == Messages.YES
            },
            confirmForce = { lease ->
                Messages.showYesNoDialog(
                    project,
                    MoeBundle.message(FORCE_MESSAGE_KEY, lease.holder, lease.stepId, task.title),
                    MoeBundle.message(FORCE_TITLE_KEY),
                    Messages.getWarningIcon()
                ) == Messages.YES
            },
            latest = { service.getState()?.tasks?.firstOrNull { it.id == task.id } },
            send = { force -> service.releaseTask(task.id, MoeBundle.message("moe.message.releasedInUI"), force) },
            stale = { lease ->
                Messages.showWarningDialog(
                    project,
                    MoeBundle.message(STALE_MESSAGE_KEY, lease.holder, lease.stepId),
                    MoeBundle.message(FORCE_TITLE_KEY)
                )
            }
        )
    }
}

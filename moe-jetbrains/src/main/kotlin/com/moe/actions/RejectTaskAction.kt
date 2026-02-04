package com.moe.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages
import com.moe.services.MoeProjectService

class RejectTaskAction : AnAction("Reject Current Task") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = MoeProjectService.getInstance(project)

        // Find first task in AWAITING_APPROVAL status
        val state = service.getState() ?: return
        val awaitingTask = state.tasks.find { it.status == "AWAITING_APPROVAL" }

        if (awaitingTask != null) {
            val reason = Messages.showInputDialog(
                project,
                "Enter rejection reason:",
                "Reject Task: ${awaitingTask.title}",
                Messages.getQuestionIcon()
            )

            if (!reason.isNullOrBlank()) {
                service.rejectTask(awaitingTask.id, reason)
            }
        }
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        if (project == null) {
            e.presentation.isEnabled = false
            return
        }

        val service = MoeProjectService.getInstance(project)
        val state = service.getState()
        val hasAwaitingTask = state?.tasks?.any { it.status == "AWAITING_APPROVAL" } == true

        e.presentation.isEnabled = hasAwaitingTask
    }
}

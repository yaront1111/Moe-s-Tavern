package com.moe.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.moe.services.MoeProjectService

class ApproveTaskAction : AnAction("Approve Current Task") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = MoeProjectService.getInstance(project)

        // Find first task in AWAITING_APPROVAL status
        val state = service.getState() ?: return
        val awaitingTask = state.tasks.find { it.status == "AWAITING_APPROVAL" }

        if (awaitingTask != null) {
            service.approveTask(awaitingTask.id)
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
        e.presentation.text = if (hasAwaitingTask) "Approve Current Task" else "No Tasks Awaiting Approval"
    }
}

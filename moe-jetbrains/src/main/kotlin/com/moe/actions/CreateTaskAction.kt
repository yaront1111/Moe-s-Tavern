package com.moe.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.moe.services.MoeProjectService
import com.moe.toolwindow.CreateTaskDialog

class CreateTaskAction : AnAction("Create New Task") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = MoeProjectService.getInstance(project)
        val state = service.getState() ?: return

        if (state.epics.isEmpty()) {
            return
        }

        // Open create task dialog
        val dialog = CreateTaskDialog(project, state.epics, service)
        dialog.show()
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        if (project == null) {
            e.presentation.isEnabled = false
            return
        }

        val service = MoeProjectService.getInstance(project)
        val state = service.getState()
        val hasEpics = state?.epics?.isNotEmpty() == true

        e.presentation.isEnabled = hasEpics
    }
}

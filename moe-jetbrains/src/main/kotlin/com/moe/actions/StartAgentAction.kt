package com.moe.actions

import com.moe.util.TerminalAgentLauncher
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class StartAllAgentsAction : AnAction("Start All Agents") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        TerminalAgentLauncher.startAgents(project)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

class StartArchitectAction : AnAction("Start Architect") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        TerminalAgentLauncher.startAgent(project, "architect")
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

class StartWorkerAction : AnAction("Start Worker") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        TerminalAgentLauncher.startAgent(project, "worker")
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

class StartQAAction : AnAction("Start QA") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        TerminalAgentLauncher.startAgent(project, "qa")
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

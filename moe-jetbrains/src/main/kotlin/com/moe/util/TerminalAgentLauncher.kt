package com.moe.util

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.io.File

object TerminalAgentLauncher {
    fun startAgents(project: Project) {
        val basePath = project.basePath ?: run {
            Messages.showErrorDialog(project, "Project path not available.", "Moe")
            return
        }

        val script = File(basePath, "scripts/moe-agent.ps1")
        if (!script.exists()) {
            Messages.showErrorDialog(
                project,
                "Agent script not found: ${script.absolutePath}",
                "Moe"
            )
            return
        }

        val manager = resolveTerminalManager(project) ?: run {
            Messages.showErrorDialog(
                project,
                "Terminal plugin not available. Enable the Terminal plugin in Settings > Plugins and restart the IDE.",
                "Moe"
            )
            return
        }

        val commands = listOf(
            "Moe Planner" to buildCommand(basePath, "architect"),
            "Moe Coder" to buildCommand(basePath, "worker"),
            "Moe QA" to buildCommand(basePath, "qa")
        )

        for ((tabName, command) in commands) {
            try {
                val widget = createTerminalWidget(manager, basePath, tabName)
                if (widget != null) {
                    sendCommand(widget, command)
                }
            } catch (ex: Exception) {
                Messages.showErrorDialog(
                    project,
                    "Failed to start terminal \"$tabName\": ${ex.message}",
                    "Moe"
                )
            }
        }
    }

    private fun buildCommand(basePath: String, role: String): String {
        val escapedPath = basePath.replace("\"", "\\\"")
        return ".\\scripts\\moe-agent.ps1 -Role $role -Project \"$escapedPath\""
    }

    private fun resolveTerminalManager(project: Project): Any? {
        return try {
            val clazz = Class.forName("org.jetbrains.plugins.terminal.TerminalToolWindowManager")
            val getInstance = clazz.getMethod("getInstance", Project::class.java)
            getInstance.invoke(null, project)
        } catch (_: Exception) {
            null
        }
    }

    private fun createTerminalWidget(manager: Any, basePath: String, tabName: String): Any? {
        val clazz = manager.javaClass
        val methods = clazz.methods.filter { it.name == "createLocalShellWidget" }
        for (method in methods) {
            val params = method.parameterTypes
            try {
                return when (params.size) {
                    2 -> method.invoke(manager, basePath, tabName)
                    3 -> method.invoke(manager, basePath, tabName, false)
                    4 -> method.invoke(manager, basePath, tabName, false, false)
                    else -> null
                }
            } catch (_: Exception) {
                // Try next overload
            }
        }
        return null
    }

    private fun sendCommand(widget: Any, command: String) {
        val widgetClass = widget.javaClass
        val send = widgetClass.methods.firstOrNull {
            it.name == "sendCommandToExecute" && it.parameterTypes.size == 1 && it.parameterTypes[0] == String::class.java
        }
        if (send != null) {
            send.invoke(widget, command)
            return
        }
        val exec = widgetClass.methods.firstOrNull {
            it.name == "executeCommand" && it.parameterTypes.size == 1 && it.parameterTypes[0] == String::class.java
        }
        exec?.invoke(widget, command)
    }
}

package com.moe.util

import com.moe.services.MoeProjectService
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.SystemInfo
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.util.UUID
import javax.swing.SwingUtilities

object TerminalAgentLauncher {
    private val LOG = Logger.getInstance(TerminalAgentLauncher::class.java)

    // Cache reflection results to avoid repeated lookups
    private val terminalManagerClass: Class<*>? by lazy {
        try {
            Class.forName("org.jetbrains.plugins.terminal.TerminalToolWindowManager")
        } catch (_: Exception) {
            null
        }
    }

    private val getInstanceMethod: Method? by lazy {
        terminalManagerClass?.getMethod("getInstance", Project::class.java)
    }

    // Cache for createLocalShellWidget methods per class (manager class may vary)
    private val shellWidgetMethodsCache = mutableMapOf<Class<*>, List<Method>>()

    // Cache for send command methods per widget class
    private val sendCommandMethodCache = mutableMapOf<Class<*>, Method?>()
    private val executeCommandMethodCache = mutableMapOf<Class<*>, Method?>()

    private enum class ScriptSource {
        PROJECT,
        BUNDLED,
        GLOBAL_CONFIG
    }

    private enum class ScriptKind {
        POWERSHELL,
        BASH
    }

    private data class ResolvedScript(
        val file: File,
        val source: ScriptSource,
        val kind: ScriptKind
    )

    private data class AgentContext(
        val basePath: String,
        val script: ResolvedScript,
        val manager: Any,
        val envOverrides: Map<String, String>,
        val agentCommand: String
    )

    private val roleTabNames = mapOf(
        "architect" to "Moe Planner",
        "worker" to "Moe Coder",
        "qa" to "Moe QA"
    )

    enum class AgentProvider(val displayName: String, val command: String) {
        CLAUDE("Claude", "claude"),
        CODEX("Codex", "codex"),
        GEMINI("Gemini", "gemini"),
        CUSTOM("Custom...", "");

        companion object {
            fun fromCommand(command: String): AgentProvider {
                return entries.firstOrNull { it != CUSTOM && it.command == command } ?: CUSTOM
            }
        }
    }

    private const val LAST_PROVIDER_KEY = "moe.lastUsedProvider"
    private const val CUSTOM_COMMAND_KEY = "moe.customAgentCommand"
    private const val TEAM_MODE_KEY = "moe.teamModeEnabled"

    fun getLastUsedProvider(project: Project): AgentProvider {
        val stored = PropertiesComponent.getInstance(project).getValue(LAST_PROVIDER_KEY, AgentProvider.CLAUDE.name)
        return try {
            AgentProvider.valueOf(stored)
        } catch (_: IllegalArgumentException) {
            AgentProvider.CLAUDE
        }
    }

    fun setLastUsedProvider(project: Project, provider: AgentProvider) {
        PropertiesComponent.getInstance(project).setValue(LAST_PROVIDER_KEY, provider.name)
    }

    fun getCustomCommand(project: Project): String {
        return PropertiesComponent.getInstance(project).getValue(CUSTOM_COMMAND_KEY, "")
    }

    fun setCustomCommand(project: Project, command: String) {
        PropertiesComponent.getInstance(project).setValue(CUSTOM_COMMAND_KEY, command)
    }

    fun isTeamModeEnabled(project: Project): Boolean =
        PropertiesComponent.getInstance(project).getBoolean(TEAM_MODE_KEY, false)

    fun setTeamModeEnabled(project: Project, enabled: Boolean) {
        PropertiesComponent.getInstance(project).setValue(TEAM_MODE_KEY, enabled)
    }

    fun resolveAgentCommand(project: Project, provider: AgentProvider): String {
        return if (provider == AgentProvider.CUSTOM) {
            getCustomCommand(project).ifEmpty { "claude" }
        } else {
            provider.command
        }
    }

    private fun resolveContext(project: Project, agentCommand: String? = null): AgentContext? {
        val basePath = project.basePath ?: run {
            Messages.showErrorDialog(project, "Project path not available.", "Moe")
            return null
        }

        val script = resolveAgentScript(basePath) ?: run {
            Messages.showErrorDialog(
                project,
                "Agent script not found. Install Moe and start the daemon once to register the install path.",
                "Moe"
            )
            return null
        }

        val manager = resolveTerminalManager(project) ?: run {
            Messages.showErrorDialog(
                project,
                "Terminal plugin not available. Enable the Terminal plugin in Settings > Plugins and restart the IDE.",
                "Moe"
            )
            return null
        }

        val envOverrides = resolveAgentEnvOverrides(script.source)
        if (script.source != ScriptSource.PROJECT && envOverrides.isEmpty()) {
            Messages.showErrorDialog(
                project,
                "Agent dependencies not found. Ensure Moe is installed and daemon/proxy are built.",
                "Moe"
            )
            return null
        }

        val resolvedCommand = agentCommand ?: MoeProjectService.getInstance(project)
            .getState()?.project?.settings?.agentCommand ?: "claude"

        return AgentContext(basePath, script, manager, envOverrides, resolvedCommand)
    }

    private fun launchRole(project: Project, ctx: AgentContext, role: String, codexExec: Boolean = false) {
        val tabName = roleTabNames[role] ?: "Moe $role"
        val defaultTeamName = project.name.takeIf { it.isNotBlank() } ?: "Moe Team"
        val teamName = if (isTeamModeEnabled(project)) defaultTeamName else null
        val command = buildCommand(ctx.basePath, role, ctx.script, ctx.envOverrides, ctx.agentCommand, teamName, codexExec)
        try {
            val widget = createTerminalWidget(ctx.manager, ctx.basePath, tabName)
            if (widget != null) {
                sendCommand(widget, command)
            } else {
                LOG.warn("Failed to create terminal widget for tab \"$tabName\"")
                Messages.showWarningDialog(
                    project,
                    "Failed to create terminal for \"$tabName\". Ensure the Terminal plugin is enabled.",
                    "Moe"
                )
            }
        } catch (ex: Exception) {
            Messages.showErrorDialog(
                project,
                "Failed to start terminal \"$tabName\": ${ex.message}",
                "Moe"
            )
        }
    }

    fun startAgents(project: Project, agentCommand: String? = null) {
        val ctx = resolveContext(project, agentCommand) ?: return
        val roles = listOf("architect", "worker", "qa")
        ApplicationManager.getApplication().executeOnPooledThread {
            for ((index, role) in roles.withIndex()) {
                try {
                    SwingUtilities.invokeAndWait {
                        launchRole(project, ctx, role)
                    }
                } catch (ex: InvocationTargetException) {
                    LOG.warn("Failed to launch agent terminal for role $role", ex.targetException ?: ex)
                } catch (ex: InterruptedException) {
                    Thread.currentThread().interrupt()
                    LOG.warn("Interrupted while launching agent terminal for role $role", ex)
                    return@executeOnPooledThread
                }

                if (index < roles.size - 1) {
                    try {
                        Thread.sleep(1500)
                    } catch (ex: InterruptedException) {
                        Thread.currentThread().interrupt()
                        LOG.warn("Interrupted while waiting between agent launches", ex)
                        return@executeOnPooledThread
                    }
                }
            }
        }
    }

    fun startAgent(project: Project, role: String, agentCommand: String? = null) {
        val ctx = resolveContext(project, agentCommand) ?: return
        launchRole(project, ctx, role)
    }

    private fun buildCommand(
        basePath: String,
        role: String,
        script: ResolvedScript,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false
    ): String {
        return when (script.kind) {
            ScriptKind.POWERSHELL -> buildPowerShellCommand(basePath, role, script.file, envOverrides, agentCommand, teamName, codexExec)
            ScriptKind.BASH -> buildBashCommand(basePath, role, script.file, envOverrides, agentCommand, teamName, codexExec)
        }
    }

    private fun buildPowerShellCommand(
        basePath: String,
        role: String,
        script: File,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false
    ): String {
        val projectArg = psQuote(basePath)
        val scriptArg = psQuote(script.absolutePath)
        val commandArg = psQuote(agentCommand)
        val envSet = if (envOverrides.isNotEmpty()) {
            envOverrides.entries.joinToString("; ") { (key, value) ->
                "\$env:$key=${psQuote(value)}"
            } + "; "
        } else {
            ""
        }
        val workerId = "$role-${UUID.randomUUID().toString().substring(0, 4)}"
        val workerIdArg = psQuote(workerId)
        val teamArg = if (teamName != null) " -Team ${psQuote(teamName)}" else ""
        val codexExecArg = if (codexExec) " -CodexExec" else ""
        val psCommand = "${envSet}& $scriptArg -Role $role -Project $projectArg -WorkerId $workerIdArg -Command $commandArg$teamArg$codexExecArg"
        val escaped = psCommand.replace("\"", "`\"").replace("\$", "`\$")
        return "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$escaped\""
    }

    private fun buildBashCommand(
        basePath: String,
        role: String,
        script: File,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false
    ): String {
        val projectArg = shQuote(basePath)
        val scriptArg = shQuote(script.absolutePath)
        val commandArg = shQuote(agentCommand)
        val envPrefix = if (envOverrides.isNotEmpty()) {
            envOverrides.entries.joinToString(" ") { (key, value) ->
                "$key=${shQuote(value)}"
            } + " "
        } else {
            ""
        }
        val workerId = "$role-${UUID.randomUUID().toString().substring(0, 4)}"
        val workerIdArg = shQuote(workerId)
        val teamArg = if (teamName != null) " --team ${shQuote(teamName)}" else ""
        val codexExecArg = if (codexExec) " --codex-exec" else ""
        return "${envPrefix}bash $scriptArg --role $role --project $projectArg --worker-id $workerIdArg --command $commandArg$teamArg$codexExecArg"
    }

    private fun psQuote(value: String): String {
        return "'" + value.replace("'", "''") + "'"
    }

    private fun shQuote(value: String): String {
        return "'" + value.replace("'", "'\"'\"'") + "'"
    }

    private fun resolveTerminalManager(project: Project): Any? {
        return try {
            getInstanceMethod?.invoke(null, project)
        } catch (_: Exception) {
            null
        }
    }

    private fun createTerminalWidget(manager: Any, basePath: String, tabName: String): Any? {
        val clazz = manager.javaClass
        val methods = shellWidgetMethodsCache.getOrPut(clazz) {
            clazz.methods.filter { it.name == "createLocalShellWidget" }
        }
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
        LOG.warn("Failed to create terminal widget: no matching createLocalShellWidget overload found for ${clazz.name}")
        return null
    }

    private fun sendCommand(widget: Any, command: String) {
        val widgetClass = widget.javaClass

        // Try cached sendCommandToExecute first
        val send = sendCommandMethodCache.getOrPut(widgetClass) {
            widgetClass.methods.firstOrNull {
                it.name == "sendCommandToExecute" && it.parameterTypes.size == 1 && it.parameterTypes[0] == String::class.java
            }
        }
        if (send != null) {
            send.invoke(widget, command)
            return
        }

        // Fall back to executeCommand
        val exec = executeCommandMethodCache.getOrPut(widgetClass) {
            widgetClass.methods.firstOrNull {
                it.name == "executeCommand" && it.parameterTypes.size == 1 && it.parameterTypes[0] == String::class.java
            }
        }
        if (exec != null) {
            exec.invoke(widget, command)
        } else {
            LOG.warn("Failed to send command to terminal: no matching method found on ${widgetClass.name}")
        }
    }

    private fun resolveAgentScript(basePath: String): ResolvedScript? {
        val preferred = if (SystemInfo.isWindows) {
            listOf(
                "scripts/moe-agent.ps1" to ScriptKind.POWERSHELL,
                "scripts/moe-agent.sh" to ScriptKind.BASH
            )
        } else {
            listOf(
                "scripts/moe-agent.sh" to ScriptKind.BASH,
                "scripts/moe-agent.ps1" to ScriptKind.POWERSHELL
            )
        }

        for ((relative, kind) in preferred) {
            val projectScript = File(basePath, relative)
            if (projectScript.exists()) {
                return ResolvedScript(projectScript, ScriptSource.PROJECT, kind)
            }
        }

        for ((relative, kind) in preferred) {
            val bundledScript = resolveBundledPath(relative)
            if (bundledScript != null) {
                return ResolvedScript(bundledScript, ScriptSource.BUNDLED, kind)
            }
        }

        // Try global install config (~/.moe/config.json)
        val installPath = MoeProjectRegistry.readGlobalInstallPath()
        if (installPath != null) {
            for ((relative, kind) in preferred) {
                val candidate = File(installPath, relative)
                if (candidate.exists()) {
                    return ResolvedScript(candidate, ScriptSource.GLOBAL_CONFIG, kind)
                }
            }
        }

        return null
    }

    private fun resolveAgentEnvOverrides(source: ScriptSource): Map<String, String> {
        if (source == ScriptSource.BUNDLED) {
            val daemon = resolveBundledPath("daemon/index.js") ?: return emptyMap()
            val proxy = resolveBundledPath("proxy/index.js") ?: return emptyMap()
            return mapOf(
                "MOE_DAEMON_PATH" to daemon.absolutePath,
                "MOE_PROXY_PATH" to proxy.absolutePath
            )
        }
        if (source == ScriptSource.GLOBAL_CONFIG) {
            val installPath = MoeProjectRegistry.readGlobalInstallPath() ?: return emptyMap()
            val daemon = File(installPath, "packages${File.separator}moe-daemon${File.separator}dist${File.separator}index.js")
            val proxy = File(installPath, "packages${File.separator}moe-proxy${File.separator}dist${File.separator}index.js")
            if (!daemon.exists() || !proxy.exists()) return emptyMap()
            return mapOf(
                "MOE_DAEMON_PATH" to daemon.absolutePath,
                "MOE_PROXY_PATH" to proxy.absolutePath
            )
        }
        return emptyMap()
    }

    private fun resolveBundledPath(relative: String): File? {
        val root = resolveBundledRoot() ?: return null
        val candidate = File(root, relative)
        return if (candidate.exists()) candidate else null
    }

    private fun resolveBundledRoot(): File? {
        return try {
            val plugin = runCatching {
                Class.forName("com.intellij.ide.plugins.PluginManagerCore")
            }.getOrNull()
            if (plugin != null) {
                val pluginInstance = com.intellij.ide.plugins.PluginManagerCore.getPlugin(
                    com.intellij.openapi.extensions.PluginId.getId("com.moe.jetbrains")
                )
                val pluginRoot = pluginInstance?.pluginPath?.toFile()
                if (pluginRoot != null && pluginRoot.exists()) return pluginRoot
            }

            val codeSource = TerminalAgentLauncher::class.java.protectionDomain?.codeSource?.location?.toURI()
            val jarFile = codeSource?.let { File(it) }
            val inferredRoot = jarFile?.parentFile?.parentFile
            if (inferredRoot != null && inferredRoot.exists()) inferredRoot else null
        } catch (_: Exception) {
            null
        }
    }
}

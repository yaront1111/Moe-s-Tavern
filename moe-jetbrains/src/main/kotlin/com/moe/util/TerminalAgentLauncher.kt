package com.moe.util

import com.moe.services.MoeProjectService
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.SystemInfo
import java.io.File
import java.lang.reflect.Method
import java.util.UUID

object TerminalAgentLauncher {
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

    private fun resolveContext(project: Project): AgentContext? {
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

        val agentCommand = MoeProjectService.getInstance(project)
            .getState()?.project?.settings?.agentCommand ?: "claude"

        return AgentContext(basePath, script, manager, envOverrides, agentCommand)
    }

    private fun launchRole(project: Project, ctx: AgentContext, role: String) {
        val tabName = roleTabNames[role] ?: "Moe $role"
        val command = buildCommand(ctx.basePath, role, ctx.script, ctx.envOverrides, ctx.agentCommand)
        try {
            val widget = createTerminalWidget(ctx.manager, ctx.basePath, tabName)
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

    fun startAgents(project: Project) {
        val ctx = resolveContext(project) ?: return
        for (role in listOf("architect", "worker", "qa")) {
            launchRole(project, ctx, role)
        }
    }

    fun startAgent(project: Project, role: String) {
        val ctx = resolveContext(project) ?: return
        launchRole(project, ctx, role)
    }

    private fun buildCommand(
        basePath: String,
        role: String,
        script: ResolvedScript,
        envOverrides: Map<String, String>,
        agentCommand: String
    ): String {
        return when (script.kind) {
            ScriptKind.POWERSHELL -> buildPowerShellCommand(basePath, role, script.file, envOverrides, agentCommand)
            ScriptKind.BASH -> buildBashCommand(basePath, role, script.file, envOverrides, agentCommand)
        }
    }

    private fun buildPowerShellCommand(
        basePath: String,
        role: String,
        script: File,
        envOverrides: Map<String, String>,
        agentCommand: String
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
        val psCommand = "${envSet}& $scriptArg -Role $role -Project $projectArg -WorkerId $workerIdArg -Command $commandArg"
        val escaped = psCommand.replace("\"", "`\"").replace("\$", "`\$")
        return "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$escaped\""
    }

    private fun buildBashCommand(
        basePath: String,
        role: String,
        script: File,
        envOverrides: Map<String, String>,
        agentCommand: String
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
        return "${envPrefix}bash $scriptArg --role $role --project $projectArg --worker-id $workerIdArg --command $commandArg"
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
        exec?.invoke(widget, command)
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

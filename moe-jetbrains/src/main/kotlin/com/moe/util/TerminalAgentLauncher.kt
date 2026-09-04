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

    private fun <K, V> boundedCache(maxSize: Int = 20): MutableMap<K, V> =
        object : LinkedHashMap<K, V>(maxSize, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, V>?): Boolean = size > maxSize
        }

    // Cache for createLocalShellWidget methods per class (manager class may vary)
    private val shellWidgetMethodsCache = boundedCache<Class<*>, List<Method>>()

    // Cache for send command methods per widget class
    private val sendCommandMethodCache = boundedCache<Class<*>, Method?>()
    private val executeCommandMethodCache = boundedCache<Class<*>, Method?>()

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
        val agentCommand: String,
        val wslAgents: Boolean = false
    )

    private val roleTabNames = mapOf(
        "architect" to "Moe Planner",
        "worker" to "Moe Coder",
        "qa" to "Moe QA",
        "governor" to "Moe Governor"
    )

    /**
     * Enum order is menu order (the Agents popup iterates `entries`); CUSTOM
     * must stay last. Every entry (CUSTOM included) needs a
     * `moe.panel.provider.<name>` bundle string; each non-custom entry's
     * `command` is the wrapper's `-Command`/`--command` value.
     */
    enum class AgentProvider(val displayName: String, val command: String) {
        CLAUDE("Claude", "claude"),
        CODEX("Codex", "codex"),
        GEMINI("Gemini", "gemini"),
        GROK("Grok", "grok"),
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
    private const val WSL_AGENTS_KEY = "moe.wslAgentsEnabled"

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

    /**
     * WSL agent mode (Windows IDE only): launch agents via moe-agent.sh with
     * /mnt/<drive>/ paths so they run as genuine Linux processes inside the
     * user's WSL terminal profile. Requires the daemon to listen beyond
     * loopback (the daemon spawner passes --host 0.0.0.0 when this is on);
     * moe-agent.sh discovers the reachable host and exports MOE_DAEMON_HOST.
     */
    fun isWslAgentsEnabled(project: Project): Boolean =
        SystemInfo.isWindows && PropertiesComponent.getInstance(project).getBoolean(WSL_AGENTS_KEY, false)

    fun setWslAgentsEnabled(project: Project, enabled: Boolean) {
        PropertiesComponent.getInstance(project).setValue(WSL_AGENTS_KEY, enabled)
    }

    /**
     * D:\projexts\app (or D:/projexts/app) -> /mnt/d/projexts/app.
     * Paths without a drive letter are returned unchanged.
     */
    internal fun toWslPath(path: String): String {
        val normalized = path.replace('\\', '/')
        val match = Regex("^([A-Za-z]):/?(.*)$").find(normalized) ?: return path
        val (drive, rest) = match.destructured
        return if (rest.isEmpty()) "/mnt/${drive.lowercase()}" else "/mnt/${drive.lowercase()}/$rest"
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

        val wslAgents = isWslAgentsEnabled(project)
        val script = resolveAgentScript(basePath, preferBash = wslAgents) ?: run {
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

        return AgentContext(basePath, script, manager, envOverrides, resolvedCommand, wslAgents)
    }

    private fun launchRole(project: Project, ctx: AgentContext, role: String, codexExec: Boolean = false) {
        val tabName = roleTabNames[role] ?: "Moe $role"
        val defaultTeamName = project.name.takeIf { it.isNotBlank() } ?: "Moe Team"
        val teamName = if (isTeamModeEnabled(project)) defaultTeamName else null
        val command = buildCommand(ctx.basePath, role, ctx.script, ctx.envOverrides, ctx.agentCommand, teamName, codexExec, ctx.wslAgents)
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
        val roles = listOf("architect", "worker", "qa", "governor")
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
        codexExec: Boolean = false,
        wslAgents: Boolean = false
    ): String {
        if (wslAgents) {
            return when (script.kind) {
                // Genuine Linux run: bash script + /mnt/<drive>/ paths, typed into
                // the user's WSL terminal profile.
                ScriptKind.BASH -> buildWslBashCommand(
                    basePath, role, script.file.absolutePath, envOverrides, agentCommand, teamName, codexExec
                )
                // Graceful degrade when only the .ps1 exists: run it on the Windows
                // side via WSL interop, with bash-safe escaping so the line survives
                // being typed into a bash prompt.
                ScriptKind.POWERSHELL -> bashWrapPowerShell(
                    buildPowerShellCommand(basePath, role, script.file, envOverrides, agentCommand, teamName, codexExec)
                )
            }
        }
        return when (script.kind) {
            ScriptKind.POWERSHELL -> buildPowerShellCommand(basePath, role, script.file, envOverrides, agentCommand, teamName, codexExec)
            ScriptKind.BASH -> buildBashCommand(basePath, role, script.file.absolutePath, envOverrides, agentCommand, teamName, codexExec)
        }
    }

    private fun buildWslBashCommand(
        basePath: String,
        role: String,
        scriptPath: String,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false
    ): String = buildBashCommand(
        toWslPath(basePath),
        role,
        toWslPath(scriptPath),
        envOverrides.mapValues { (_, v) -> toWslPath(v) },
        agentCommand,
        teamName,
        codexExec
    )

    internal fun buildWslBashCommandForTest(
        basePath: String,
        role: String,
        scriptPath: String,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false
    ): String = buildWslBashCommand(basePath, role, scriptPath, envOverrides, agentCommand, teamName, codexExec)

    /**
     * Convert a `powershell -NoProfile ... -Command "..."` line (backtick-escaped
     * for a PowerShell host) into one that survives a bash prompt: interop needs
     * the .exe suffix, and bash double quotes eat `$`, backticks, and `"` unless
     * backslash-escaped. The PowerShell-level backtick escaping is first undone,
     * then re-escaped for bash.
     */
    internal fun bashWrapPowerShell(psLine: String): String {
        val prefix = "powershell -NoProfile -ExecutionPolicy Bypass -Command \""
        if (!psLine.startsWith(prefix) || !psLine.endsWith("\"")) return psLine
        val inner = psLine.removePrefix(prefix).removeSuffix("\"")
            .replace("`\"", "\"").replace("`\$", "\$")
        val bashEscaped = inner
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\$", "\\\$")
            .replace("`", "\\`")
        return "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"$bashEscaped\""
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
        val workerId = "$role-${UUID.randomUUID().toString().replace("-", "").substring(0, 8)}"
        val workerIdArg = psQuote(workerId)
        val teamArg = if (teamName != null) " -Team ${psQuote(teamName)}" else ""
        val execArg = if (codexExec) {
            val provider = AgentProvider.fromCommand(agentCommand)
            when (provider) {
                AgentProvider.CODEX -> " -CodexExec"
                AgentProvider.GEMINI -> " -GeminiExec"
                AgentProvider.GROK -> " -GrokExec"
                // CLAUDE / CUSTOM keep the historical -CodexExec (the wrapper
                // ignores it for non-codex commands; tests pin this).
                else -> " -CodexExec"
            }
        } else ""
        val interactiveArg = if (shouldLaunchClaudeInteractive(role, agentCommand, codexExec)) " -Interactive" else ""
        val psCommand = "${envSet}& $scriptArg -Role $role -Project $projectArg -WorkerId $workerIdArg -Command $commandArg$teamArg$execArg$interactiveArg"
        val escaped = psCommand.replace("\"", "`\"").replace("\$", "`\$")
        return "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$escaped\""
    }

    /**
     * Gate: when does JetBrains opt a role into Claude's interactive TUI?
     *
     * - Architect: always (planning benefits from clarifying questions in the REPL).
     * - Governor: always — oversight is interactive; the operator steers escalations.
     * - QA: never — verification is mechanical, --print stream-json is preferable.
     * - Worker: never — the TUI does not exit when the agent finishes a task, and
     *   the wrapper blocks inside that call for the TUI's whole lifetime. Its
     *   post-flight (session-end announce, and the auto-commit+push that ships a
     *   REVIEW task) lives strictly AFTER that call, so an interactive worker
     *   never reaches it. Observed 2026-07-31: across the whole project chat
     *   history there were 13 "qa session ended" messages and zero "worker
     *   session ended", finished work piled up uncommitted, and a human had to
     *   land it by hand. Workers stay on one-shot --print, which exits at
     *   end_turn; the stream-json parser still prints every tool call live.
     *
     * Codex / Gemini / Grok providers ignore this gate: they have their own native
     * TUI vs headless toggles (`-CodexExec`, `-GeminiExec`, `-GrokExec`). Grok's
     * role-based interactive polarity (architect/governor TUI, worker/qa headless)
     * lives in the wrapper, not here — JetBrains never passes `-Interactive` for
     * it. codexExec=true also forces a non-interactive run regardless of role.
     */
    internal fun shouldLaunchClaudeInteractive(
        role: String,
        agentCommand: String,
        codexExec: Boolean
    ): Boolean =
        (role == "architect" || role == "governor") &&
            !codexExec &&
            AgentProvider.fromCommand(agentCommand) == AgentProvider.CLAUDE

    internal fun buildPowerShellCommandForTest(
        basePath: String,
        role: String,
        scriptPath: String,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false
    ): String =
        buildPowerShellCommand(
            basePath,
            role,
            File(scriptPath),
            envOverrides,
            agentCommand,
            teamName,
            codexExec
        )

    private fun buildBashCommand(
        basePath: String,
        role: String,
        scriptPath: String,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false
    ): String {
        val projectArg = shQuote(basePath)
        val scriptArg = shQuote(scriptPath)
        val commandArg = shQuote(agentCommand)
        val envPrefix = if (envOverrides.isNotEmpty()) {
            envOverrides.entries.joinToString(" ") { (key, value) ->
                "$key=${shQuote(value)}"
            } + " "
        } else {
            ""
        }
        val workerId = "$role-${UUID.randomUUID().toString().replace("-", "").substring(0, 8)}"
        val workerIdArg = shQuote(workerId)
        val teamArg = if (teamName != null) " --team ${shQuote(teamName)}" else ""
        val execArg = if (codexExec) {
            val provider = AgentProvider.fromCommand(agentCommand)
            when (provider) {
                AgentProvider.CODEX -> " --codex-exec"
                AgentProvider.GEMINI -> " --gemini-exec"
                AgentProvider.GROK -> " --grok-exec"
                // CLAUDE / CUSTOM keep the historical --codex-exec (the wrapper
                // ignores it for non-codex commands; mirrors the PowerShell arm,
                // whose fallback is the test-pinned one).
                else -> " --codex-exec"
            }
        } else ""
        val interactiveArg = if (shouldLaunchClaudeInteractive(role, agentCommand, codexExec)) " --interactive" else ""
        return "${envPrefix}bash $scriptArg --role $role --project $projectArg --worker-id $workerIdArg --command $commandArg$teamArg$execArg$interactiveArg"
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
                    else -> continue
                }
            } catch (ex: InvocationTargetException) {
                // Method matched and was invoked, but the call itself failed.
                // Don't keep trying other overloads — that masks the real failure.
                LOG.warn(
                    "createLocalShellWidget(${params.joinToString { it.simpleName }}) on ${clazz.name} threw",
                    ex.targetException ?: ex
                )
                return null
            } catch (_: IllegalArgumentException) {
                // Argument type mismatch for this overload — try next.
            } catch (ex: IllegalAccessException) {
                LOG.debug("createLocalShellWidget overload not accessible on ${clazz.name}: ${ex.message}", ex)
            }
        }
        LOG.warn("Failed to create terminal widget: no matching createLocalShellWidget overload found for ${clazz.name}")
        return null
    }

    private fun sendCommand(widget: Any, command: String): Boolean {
        // Try direct PTY write first - works regardless of shell integration or tab focus
        if (writeToTtyConnector(widget, command)) return true

        val widgetClass = widget.javaClass

        // Prefer executeCommand - writes directly to terminal input, more reliable for unfocused tabs
        val exec = executeCommandMethodCache.getOrPut(widgetClass) {
            widgetClass.methods.firstOrNull {
                it.name == "executeCommand" && it.parameterTypes.size == 1 && it.parameterTypes[0] == String::class.java
            }
        }
        if (exec != null) {
            try {
                exec.invoke(widget, command)
                return true
            } catch (ex: InvocationTargetException) {
                LOG.warn("executeCommand on ${widgetClass.name} threw", ex.targetException ?: ex)
                return false
            } catch (ex: IllegalAccessException) {
                LOG.warn("executeCommand on ${widgetClass.name} not accessible", ex)
                return false
            }
        }

        // Last resort: sendCommandToExecute (requires shell integration, may not work in unfocused tabs)
        val send = sendCommandMethodCache.getOrPut(widgetClass) {
            widgetClass.methods.firstOrNull {
                it.name == "sendCommandToExecute" && it.parameterTypes.size == 1 && it.parameterTypes[0] == String::class.java
            }
        }
        if (send != null) {
            try {
                send.invoke(widget, command)
                return true
            } catch (ex: InvocationTargetException) {
                LOG.warn("sendCommandToExecute on ${widgetClass.name} threw", ex.targetException ?: ex)
                return false
            } catch (ex: IllegalAccessException) {
                LOG.warn("sendCommandToExecute on ${widgetClass.name} not accessible", ex)
                return false
            }
        }
        LOG.warn("Failed to send command to terminal: no matching method found on ${widgetClass.name}")
        return false
    }

    private fun writeToTtyConnector(widget: Any, command: String): Boolean {
        return try {
            val tty = findTtyConnector(widget) ?: return false
            val writeMethod = tty.javaClass.methods.firstOrNull {
                it.name == "write" && it.parameterTypes.size == 1 && it.parameterTypes[0] == ByteArray::class.java
            } ?: return false
            writeMethod.invoke(tty, (command + "\n").toByteArray(Charsets.UTF_8))
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun findTtyConnector(widget: Any): Any? {
        for (methodName in listOf("getTtyConnector", "getProcessTtyConnector")) {
            try {
                val method = widget.javaClass.methods.firstOrNull {
                    it.name == methodName && it.parameterTypes.isEmpty()
                } ?: continue
                return method.invoke(widget)
            } catch (_: Exception) {
                continue
            }
        }
        return null
    }

    private fun resolveAgentScript(basePath: String, preferBash: Boolean = false): ResolvedScript? {
        val preferred = if (SystemInfo.isWindows && !preferBash) {
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

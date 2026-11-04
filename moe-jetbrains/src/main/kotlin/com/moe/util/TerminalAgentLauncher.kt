package com.moe.util

import com.moe.model.AccountCli
import com.moe.model.ReadinessFailure
import com.moe.model.ReadinessReply
import com.moe.services.MoeProjectService
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.SystemInfo
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.nio.file.InvalidPathException
import java.nio.file.Paths
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
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

    internal enum class ScriptSource {
        PROJECT,
        BUNDLED,
        GLOBAL_CONFIG
    }

    internal enum class ScriptKind {
        POWERSHELL,
        BASH
    }

    internal data class ResolvedScript(
        val file: File,
        val source: ScriptSource,
        val kind: ScriptKind
    )

    internal sealed interface ProtectedAgentRuntime {
        data class Selected(val script: ResolvedScript, val env: Map<String, String>) : ProtectedAgentRuntime
        data class Refused(val reason: String) : ProtectedAgentRuntime {
            val message: String
                get() = "Protected execution profile: $reason. " +
                    "Agents only use the wrapper, daemon and proxy installed with the Moe plugin."
        }
    }

    internal sealed interface AgentCommandChoice {
        data class Run(val command: String) : AgentCommandChoice
        data class Refused(val message: String) : AgentCommandChoice
    }

    /**
     * Contract with scripts/moe-agent.{sh,ps1} (CQ-R13c2): exactly "1", set only by [selectProtectedAgentRuntime]
     * under the PROTECTED profile, so the wrappers refuse to fall back from MOE_DAEMON_PATH/MOE_PROXY_PATH.
     * A MOE_RUNTIME_PROTECTED already in the IDE's own environment would make a legacy wrapper refuse its
     * fallback too; that fails closed, so it is not stripped.
     */
    internal const val PROTECTED_RUNTIME_MARKER = "MOE_RUNTIME_PROTECTED"

    /**
     * The strong profile's agent runtime: the wrapper, daemon and proxy installed with the plugin,
     * each a real file inside [root] and outside the project. The wrapper keeps the legacy
     * preference order; the project's scripts/ and the global install path are never consulted.
     */
    internal fun selectProtectedAgentRuntime(
        basePath: String,
        preferBash: Boolean,
        root: File?,
        windows: Boolean = SystemInfo.isWindows
    ): ProtectedAgentRuntime {
        val wrappers = listOf("scripts/moe-agent.ps1" to ScriptKind.POWERSHELL, "scripts/moe-agent.sh" to ScriptKind.BASH)
        val reasons = mutableListOf<String>()
        val script = (if (windows && !preferBash) wrappers else wrappers.reversed()).firstNotNullOfOrNull { (relative, kind) ->
            when (val selection = RuntimeSelectionPolicy.installedArtifact(root, relative, basePath)) {
                is RuntimeSelection.Accepted -> ResolvedScript(selection.file, ScriptSource.BUNDLED, kind)
                is RuntimeSelection.Rejected -> { reasons += selection.reason; null }
            }
        } ?: return ProtectedAgentRuntime.Refused(reasons.first())
        val env = linkedMapOf<String, String>()
        for ((name, relative) in listOf("MOE_DAEMON_PATH" to "daemon/index.js", "MOE_PROXY_PATH" to "proxy/index.js")) {
            when (val selection = RuntimeSelectionPolicy.installedArtifact(root, relative, basePath)) {
                is RuntimeSelection.Accepted -> env[name] = selection.file.path
                is RuntimeSelection.Rejected -> return ProtectedAgentRuntime.Refused(selection.reason)
            }
        }
        env[PROTECTED_RUNTIME_MARKER] = "1"
        return ProtectedAgentRuntime.Selected(script, env)
    }

    internal sealed interface ProtectedInterpreter {
        data class Ready(val word: String) : ProtectedInterpreter
        data class Refused(val reason: String) : ProtectedInterpreter
    }

    internal fun protectedInterpreter(
        kind: ScriptKind,
        wslAgents: Boolean,
        basePath: String,
        windows: Boolean = SystemInfo.isWindows,
        systemRoot: String? = System.getenv("SystemRoot"),
        bash: String = "/bin/bash",
        subject: String = "the agent wrapper's interpreter"
    ): ProtectedInterpreter {
        val candidate = when {
            !windows && kind == ScriptKind.BASH -> bash
            windows && kind == ScriptKind.BASH && wslAgents -> {
                // Windows cannot stat the distro's fixed /bin/bash; if absent, its shell fails without a project lookup.
                return ProtectedInterpreter.Ready("/bin/bash")
            }
            windows && kind == ScriptKind.POWERSHELL -> {
                if (systemRoot.isNullOrBlank()) return ProtectedInterpreter.Refused(
                    "SystemRoot is not set, so Windows PowerShell cannot be found"
                )
                try {
                    Paths.get(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe").toString()
                } catch (_: InvalidPathException) {
                    return ProtectedInterpreter.Refused("SystemRoot $systemRoot is not a valid Windows PowerShell path")
                }
            }
            else -> return ProtectedInterpreter.Refused("no trusted interpreter runs the installed $kind wrapper on this host")
        }
        val file = when (val selection = RuntimeSelectionPolicy.installedExecutable(candidate, basePath)) {
            is RuntimeSelection.Accepted -> selection.file
            is RuntimeSelection.Rejected -> return ProtectedInterpreter.Refused(
                "$subject $candidate is not an absolute regular file outside the project"
            )
        }
        if (!windows) return ProtectedInterpreter.Ready(file.path)
        val word = file.path.replace('\\', '/')
        if (!Regex("^[A-Za-z]:(/[A-Za-z0-9._-]+)+$").matches(word)) return ProtectedInterpreter.Refused(
            "$subject ${file.path} holds a character a terminal cannot take unquoted"
        )
        return ProtectedInterpreter.Ready(if (wslAgents) toWslPath(file.path) else word)
    }

    /** Null under the legacy profile, so the legacy resolution runs; otherwise the installed selection or its refusal. */
    internal fun protectedAgentRuntime(
        basePath: String,
        preferBash: Boolean,
        root: () -> File? = { RuntimeSelectionPolicy.installedRoot() }
    ): ProtectedAgentRuntime? = if (RuntimeSelectionPolicy.profile(basePath) == RuntimeProfile.PROTECTED) {
        selectProtectedAgentRuntime(basePath, preferBash, root())
    } else {
        null
    }

    private data class AgentContext(
        val basePath: String,
        val script: ResolvedScript,
        val manager: Any,
        val envOverrides: Map<String, String>,
        val agentCommand: String,
        val wslAgents: Boolean = false,
        val interpreter: String? = null
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

    // The protected profile runs these agent CLIs by exact name only; the wrappers accept the same set (task-aa85ff13).
    private val PROTECTED_AGENT_COMMANDS = AgentProvider.entries.filter { it != AgentProvider.CUSTOM }.map { it.command }
    private const val MAX_SHOWN_AGENT_COMMAND = 200
    private const val VM_SEAT_NOT_PROTECTED = "Moe did not start the agent: .moe/project.json no longer asks for " +
        "verified-local, so this worker or QA seat has no protected wrapper to run. Nothing was started; try again."
    // The service's own bound plus margin; its future completes TIMEOUT by itself at 20 s.
    private const val VM_READINESS_WAIT_MS = MoeProjectService.READINESS_TIMEOUT_MS + 5_000L

    /**
     * Under PROTECTED, repository content (.moe/project.json settings.agentCommand) and custom commands never choose
     * the binary a seat runs: only an exact known CLI name passes. LEGACY keeps explicit, then the setting, then claude.
     */
    internal fun agentCommandFor(profile: RuntimeProfile, explicit: String?, projectSetting: String?, vmSeat: Boolean = false): AgentCommandChoice {
        // A VM seat runs only a CLI the guest has, whatever the profile allows on the host.
        if (vmSeat) VerifiedLocalLaunch.agentRefusal(explicit ?: projectSetting ?: "claude")?.let { return AgentCommandChoice.Refused(it) }
        if (profile == RuntimeProfile.LEGACY) return AgentCommandChoice.Run(explicit ?: projectSetting ?: "claude")
        val candidate = (explicit ?: projectSetting)?.trim() ?: "claude"
        if (candidate in PROTECTED_AGENT_COMMANDS) return AgentCommandChoice.Run(candidate)
        val shown = candidate.take(MAX_SHOWN_AGENT_COMMAND).map { if (Character.isISOControl(it)) '?' else it }.joinToString("")
        val source = if (explicit != null) "custom command" else "from .moe/project.json settings.agentCommand"
        return AgentCommandChoice.Refused(
            "Protected execution profile: the agent command '$shown' ($source) is not one of " +
                "${PROTECTED_AGENT_COMMANDS.joinToString(", ")}, so no agent was started. Pick an agent from the Agents menu."
        )
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
     * loopback (the daemon spawner passes --host wsl when this is on: loopback plus the WSL adapter, not every interface);
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

    /** [vmSeat]: a worker or QA seat on the verified-local VM route, which runs only the installed wrapper. */
    private fun resolveContext(project: Project, agentCommand: String? = null, vmSeat: Boolean = false): AgentContext? {
        val basePath = project.basePath ?: run {
            Messages.showErrorDialog(project, "Project path not available.", "Moe")
            return null
        }

        val wslAgents = isWslAgentsEnabled(project)
        val selected = when (val runtime = protectedAgentRuntime(basePath, VerifiedLocalLaunch.preferBash(vmSeat, wslAgents))) {
            is ProtectedAgentRuntime.Refused -> {
                Messages.showErrorDialog(project, runtime.message, "Moe")
                return null
            }
            is ProtectedAgentRuntime.Selected -> runtime
            // Only a setting changed since the profile was read gets here; a VM seat never takes the legacy script.
            null -> if (vmSeat) {
                Messages.showErrorDialog(project, VM_SEAT_NOT_PROTECTED, "Moe")
                return null
            } else {
                null
            }
        }
        val interpreter = selected?.let {
            when (val resolved = protectedInterpreter(it.script.kind, wslAgents, basePath)) {
                is ProtectedInterpreter.Ready -> resolved.word
                is ProtectedInterpreter.Refused -> {
                    Messages.showErrorDialog(project, ProtectedAgentRuntime.Refused(resolved.reason).message, "Moe")
                    return null
                }
            }
        }
        val script = selected?.script ?: resolveAgentScript(basePath, preferBash = wslAgents) ?: run {
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

        val envOverrides = selected?.env ?: resolveAgentEnvOverrides(script.source)
        if (script.source != ScriptSource.PROJECT && envOverrides.isEmpty()) {
            Messages.showErrorDialog(
                project,
                "Agent dependencies not found. Ensure Moe is installed and daemon/proxy are built.",
                "Moe"
            )
            return null
        }

        // `selected` is non-null exactly under PROTECTED, so project.json is not read a second time.
        val profile = if (selected != null) RuntimeProfile.PROTECTED else RuntimeProfile.LEGACY
        val projectSetting = MoeProjectService.getInstance(project).getState()?.project?.settings?.agentCommand
        val resolvedCommand = when (val choice = agentCommandFor(profile, agentCommand, projectSetting, vmSeat)) {
            is AgentCommandChoice.Run -> choice.command
            is AgentCommandChoice.Refused -> {
                Messages.showErrorDialog(project, choice.message, "Moe")
                return null
            }
        }

        return AgentContext(basePath, script, manager, envOverrides, resolvedCommand, wslAgents, interpreter)
    }

    /**
     * The only way a seat reaches the terminal manager: a [VerifiedLocalLaunch.Decision.Refused] reports through
     * [refuse] and never touches [manager].
     */
    internal fun openSeat(decision: VerifiedLocalLaunch.Decision, manager: Any, basePath: String, tabName: String, refuse: (String) -> Unit): Any? =
        when (decision) {
            is VerifiedLocalLaunch.Decision.Refused -> null.also { refuse(decision.message) }
            VerifiedLocalLaunch.Decision.Launch -> createTerminalWidget(manager, basePath, tabName)
        }

    private fun launchRole(project: Project, ctx: AgentContext, role: String, codexExec: Boolean = false, decision: VerifiedLocalLaunch.Decision = VerifiedLocalLaunch.Decision.Launch) {
        val tabName = roleTabNames[role] ?: "Moe $role"
        try {
            // Built before any tab opens, so a value the builder refuses lands in the catch below with no terminal.
            val launch = if (decision is VerifiedLocalLaunch.Decision.Refused) null else {
                val defaultTeamName = project.name.takeIf { it.isNotBlank() } ?: "Moe Team"
                val teamName = if (isTeamModeEnabled(project)) defaultTeamName else null
                val workerId = newWorkerId(role)
                workerId to buildCommand(ctx.basePath, role, ctx.script, ctx.envOverrides, ctx.agentCommand, teamName, codexExec, ctx.wslAgents, workerId, ctx.interpreter)
            }
            val widget = openSeat(decision, ctx.manager, ctx.basePath, tabName) { Messages.showErrorDialog(project, it, "Moe") }
            // A refusal has shown its one dialog: no command is built and no terminal exists.
            if (launch == null) return
            if (widget != null) {
                val (workerId, command) = launch
                if (sendCommand(widget, command)) trackSeat(project, widget, workerId)
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

    private fun newWorkerId(role: String): String =
        "$role-${UUID.randomUUID().toString().replace("-", "").substring(0, 8)}"

    /**
     * A wrapper killed with its tab (tab closed, IDE exit or crash) never runs
     * the exit trap that deregisters its seat, so the IDE does it: when the tab
     * is disposed, and at the next daemon connect for a seat whose tab died with
     * the IDE (see AgentSeatTracker).
     */
    private fun trackSeat(project: Project, widget: Any, workerId: String) {
        val service = MoeProjectService.getInstance(project)
        service.agentSeatLaunched(workerId)
        val tab = widget as? Disposable ?: return
        try {
            Disposer.register(tab, Disposable { service.agentSeatClosed(workerId) })
        } catch (ex: Exception) {
            // The tab was disposed before it could be watched.
            LOG.debug("Agent tab for $workerId already disposed: ${ex.message}")
            service.agentSeatClosed(workerId)
        }
    }

    /** Worker and QA under verified-local: their VM-route context and the one readiness answer that decides both. */
    private class VmSeats(val ctx: AgentContext, val readiness: CompletableFuture<ReadinessReply>) {
        // Touched only by the launching pooled thread.
        var decision: VerifiedLocalLaunch.Decision? = null
    }

    fun startAgents(project: Project, agentCommand: String? = null) {
        val ctx = resolveContext(project, agentCommand) ?: return
        val declared = RuntimeSelectionPolicy.declaredProfile(ctx.basePath)
        val vm = if (VerifiedLocalLaunch.isVmSeat("worker", declared)) {
            val vmCtx = resolveContext(project, agentCommand, vmSeat = true) ?: return
            VmSeats(vmCtx, MoeProjectService.getInstance(project).requestExecutionReadiness())
        } else {
            null
        }
        val roles = listOf("architect", "worker", "qa", "governor")
        ApplicationManager.getApplication().executeOnPooledThread {
            for ((index, role) in roles.withIndex()) {
                val seats = vm?.takeIf { VerifiedLocalLaunch.isVmSeat(role, declared) }
                // A refusal showed its one dialog at the first VM seat; the other opens nothing.
                if (seats?.decision is VerifiedLocalLaunch.Decision.Refused) continue
                val (seatCtx, decision) = if (seats == null) {
                    ctx to VerifiedLocalLaunch.Decision.Launch
                } else {
                    val vmDecision = seats.decision ?: awaitVmDecision(project, seats.readiness) ?: return@executeOnPooledThread
                    seats.decision = vmDecision
                    seats.ctx to vmDecision
                }
                try {
                    SwingUtilities.invokeAndWait {
                        launchRole(project, seatCtx, role, decision = decision)
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

    /** Bounded and never on the EDT. Null when interrupted or the project closed meanwhile. */
    private fun awaitVmDecision(project: Project, readiness: CompletableFuture<ReadinessReply>): VerifiedLocalLaunch.Decision? {
        val reply = try {
            readiness.get(VM_READINESS_WAIT_MS, TimeUnit.MILLISECONDS)
        } catch (ex: InterruptedException) {
            Thread.currentThread().interrupt()
            LOG.warn("Interrupted while waiting for the daemon's execution readiness", ex)
            return null
        } catch (_: TimeoutException) {
            ReadinessReply.Failed(ReadinessFailure.TIMEOUT)
        } catch (_: ExecutionException) {
            ReadinessReply.Failed(ReadinessFailure.TIMEOUT)
        }
        return if (project.isDisposed) null else VerifiedLocalLaunch.decide("worker and QA", reply)
    }

    fun startAgent(project: Project, role: String, agentCommand: String? = null) {
        val basePath = project.basePath
        if (basePath == null || !VerifiedLocalLaunch.isVmSeat(role, RuntimeSelectionPolicy.declaredProfile(basePath))) {
            val ctx = resolveContext(project, agentCommand) ?: return
            launchRole(project, ctx, role)
            return
        }
        val ctx = resolveContext(project, agentCommand, vmSeat = true) ?: return
        val seat = if (role == "qa") "QA" else role
        // The answer arrives off the EDT; the launch, or its one refusal dialog, runs on the EDT unless the project closed.
        MoeProjectService.getInstance(project).requestExecutionReadiness().thenAccept { reply ->
            ApplicationManager.getApplication().invokeLater(
                { launchRole(project, ctx, role, decision = VerifiedLocalLaunch.decide(seat, reply)) },
                project.disposed
            )
        }
    }

    /** The shell an Accounts tab command is typed into: the one agents run in. */
    internal enum class AccountsShell { POWERSHELL, WSL_BASH, BASH }

    internal fun accountsShellFor(windows: Boolean, wslAgents: Boolean): AccountsShell = when {
        windows && wslAgents -> AccountsShell.WSL_BASH
        windows -> AccountsShell.POWERSHELL
        else -> AccountsShell.BASH
    }

    /**
     * `node <cli.js> --accounts-file <file> <args>` with every word quoted. Under
     * WSL the daemon's Windows paths become /mnt paths for WSL's own node, so
     * claude signs in where WSL agents run it. [interpreter] replaces the PowerShell line's bare `powershell`
     * word (the protected profile's pinned System32 path); the other shells ignore it.
     */
    internal fun buildAccountsCommand(
        cli: AccountCli, registryFile: String, args: List<String>, shell: AccountsShell, interpreter: String? = null
    ): String {
        (listOf(cli.node, cli.script, registryFile) + args).forEach { requireSafeArg("accounts command word", it) }
        return when (shell) {
            AccountsShell.POWERSHELL -> powerShellLine(
                "& " + (listOf(cli.node, cli.script, "--accounts-file", registryFile) + args).joinToString(" ") { psQuote(it) },
                interpreter ?: "powershell"
            )
            AccountsShell.WSL_BASH ->
                "node " + (listOf(toWslPath(cli.script), "--accounts-file", toWslPath(registryFile)) + args).joinToString(" ") { shQuote(it) }
            AccountsShell.BASH ->
                (listOf(cli.node, cli.script, "--accounts-file", registryFile) + args).joinToString(" ") { shQuote(it) }
        }
    }

    /**
     * The protected WSL Accounts program, typed after the fixed /bin/bash: WSL's node has no fixed system path. Bash
     * builtins only, then `exec node`. It applies protected_trusted_dir from scripts/moe-agent.sh and scripts/moe-call.sh
     * (task-0b2ea570): keep, as real paths and in order, the absolute PATH entries whose real path is neither the project
     * ($1) nor under it, walking ancestors with -ef so a link cannot hide the project. Keeping nothing refuses, because an
     * empty PATH makes bash search the cwd, which is the project. No ', backslash or ! so bash, zsh and fish type it alike.
     */
    internal const val PROTECTED_WSL_NODE_PROGRAM = "f() { echo \"[ERROR] MOE_PROTECTED_INTERPRETER_NOT_FOUND: node was not found on an absolute PATH entry outside the project; refusing to start.\" >&2; exit 1; }; p=\$(cd -- \"\$1\" 2>/dev/null && pwd -P) || f; shift; k=; IFS=: read -r -a e <<< \"\$PATH\"; for d in \"\${e[@]}\"; do case \$d in /*) ;; *) continue ;; esac; r=\$(cd -- \"\$d\" 2>/dev/null && pwd -P) || continue; u=\$r; while :; do [ \"\$u\" -ef \"\$p\" ] && continue 2; [ \"\$u\" = / ] && break; u=\${u%/*}; u=\${u:-/}; done; k=\${k:+\$k:}\$r; done; [ -n \"\$k\" ] || f; PATH=\$k; exec node \"\$@\""

    /**
     * The accounts CLI option every protected Accounts line passes with the project
     * (packages/moe-daemon/src/accounts/cli.ts, task-55710898): the CLI then runs claude only from outside the
     * project, with PATH = those entries and cwd = the home folder, or refuses before anything runs.
     */
    internal const val PROTECTED_PROJECT_OPTION = "--protected-project"

    private fun protectedAccountsRefusal(reason: String): Nothing = throw IllegalArgumentException(
        "Protected execution profile: $reason. Moe runs account commands only with an interpreter outside the project, so nothing was started."
    )

    /**
     * `/bin/bash -c <PROTECTED_WSL_NODE_PROGRAM> moe-accounts <project> <cli.js> --accounts-file <registry>
     * --protected-project <project> ...`: WSL's own node, found only outside the project, and the CLI's claude too.
     */
    private fun protectedWslAccountsCommand(cli: AccountCli, registryFile: String, args: List<String>, basePath: String): String {
        if (!Regex("^[A-Za-z]:[\\\\/]").containsMatchIn(basePath)) {
            protectedAccountsRefusal("the project $basePath has no /mnt path in WSL, so WSL's node cannot be checked against it")
        }
        val project = toWslPath(basePath)
        val words = listOf(toWslPath(cli.script), "--accounts-file", toWslPath(registryFile), PROTECTED_PROJECT_OPTION, project) + args
        (listOf(project) + words).forEach { requireSafeArg("accounts command word", it) }
        val word = when (val resolved = protectedInterpreter(ScriptKind.BASH, wslAgents = true, basePath = basePath, windows = true)) {
            is ProtectedInterpreter.Ready -> resolved.word
            is ProtectedInterpreter.Refused -> protectedAccountsRefusal(resolved.reason)
        }
        return shQuote(word) + " -c " + shQuote(PROTECTED_WSL_NODE_PROGRAM) + " moe-accounts " + shQuote(project) + " " +
            words.joinToString(" ") { shQuote(it) }
    }

    /**
     * LEGACY: [buildAccountsCommand] unchanged. PROTECTED: no interpreter is looked up through the project cwd or PATH.
     * Native routes type the real path of [cli]'s node, checked outside the project, and Windows the pinned System32
     * PowerShell; WSL runs [PROTECTED_WSL_NODE_PROGRAM]. Every route passes [PROTECTED_PROJECT_OPTION] and the project
     * after the registry, so the CLI's own claude lookup skips the project too. A refusal throws IllegalArgumentException.
     */
    internal fun accountsCommandFor(
        profile: RuntimeProfile,
        cli: AccountCli,
        registryFile: String,
        args: List<String>,
        shell: AccountsShell,
        basePath: String,
        systemRoot: String? = System.getenv("SystemRoot")
    ): String {
        if (profile == RuntimeProfile.LEGACY) return buildAccountsCommand(cli, registryFile, args, shell)
        if (shell == AccountsShell.WSL_BASH) return protectedWslAccountsCommand(cli, registryFile, args, basePath)
        val interpreter = if (shell != AccountsShell.POWERSHELL) null else when (val resolved = protectedInterpreter(
            ScriptKind.POWERSHELL, wslAgents = false, basePath = basePath, systemRoot = systemRoot, subject = "the Accounts command's PowerShell"
        )) {
            is ProtectedInterpreter.Ready -> resolved.word
            is ProtectedInterpreter.Refused -> protectedAccountsRefusal(resolved.reason)
        }
        val node = when (val selection = RuntimeSelectionPolicy.installedExecutable(cli.node, basePath)) {
            is RuntimeSelection.Accepted -> selection.file.path
            is RuntimeSelection.Rejected ->
                protectedAccountsRefusal("the Accounts command's node ${cli.node} is not an absolute regular file outside the project")
        }
        return buildAccountsCommand(cli.copy(node = node), registryFile, listOf(PROTECTED_PROJECT_OPTION, basePath) + args, shell, interpreter)
    }

    /** The accounts CLI line for this project's agent shell, for a person to run when no terminal tab can. */
    fun accountsCommandLine(project: Project, cli: AccountCli, registryFile: String, args: List<String>): String {
        val basePath = project.basePath ?: ""
        val shell = accountsShellFor(SystemInfo.isWindows, isWslAgentsEnabled(project))
        return accountsCommandFor(RuntimeSelectionPolicy.profile(basePath), cli, registryFile, args, shell, basePath)
    }

    /**
     * Runs the daemon's `accounts` CLI in a new terminal tab (sign in, check, sign
     * out): claude's own sign-in prompts need a person, and the daemon never runs
     * claude. False when no terminal tab could run it. Throws IllegalArgumentException,
     * before any tab opens, for a word holding a control character, or when the
     * protected profile has no trusted interpreter for the line.
     */
    fun runAccountsCommand(project: Project, cli: AccountCli, registryFile: String, args: List<String>, tabName: String): Boolean {
        val line = accountsCommandLine(project, cli, registryFile, args)
        val manager = resolveTerminalManager(project) ?: return false
        val workingDir = project.basePath ?: System.getProperty("user.home")
        val widget = runCatching { createTerminalWidget(manager, workingDir, tabName) }.getOrNull() ?: return false
        return sendCommand(widget, line)
    }

    private fun buildCommand(
        basePath: String,
        role: String,
        script: ResolvedScript,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false,
        wslAgents: Boolean = false,
        workerId: String = newWorkerId(role),
        interpreter: String? = null
    ): String {
        if (wslAgents) {
            return when (script.kind) {
                // Genuine Linux run: bash script + /mnt/<drive>/ paths, typed into
                // the user's WSL terminal profile.
                ScriptKind.BASH -> buildWslBashCommand(
                    basePath, role, script.file.absolutePath, envOverrides, agentCommand, teamName, codexExec, workerId, interpreter
                )
                // Graceful degrade when only the .ps1 exists: run it on the Windows
                // side via WSL interop. The line is only base64 after its prefix, so
                // it needs no bash escaping to survive a bash prompt.
                ScriptKind.POWERSHELL -> {
                    val line = buildPowerShellCommand(basePath, role, script.file, envOverrides, agentCommand, teamName, codexExec, workerId, interpreter)
                    if (interpreter != null) line else bashWrapPowerShell(line)
                }
            }
        }
        return when (script.kind) {
            ScriptKind.POWERSHELL -> buildPowerShellCommand(basePath, role, script.file, envOverrides, agentCommand, teamName, codexExec, workerId, interpreter)
            ScriptKind.BASH -> buildBashCommand(basePath, role, script.file.absolutePath, envOverrides, agentCommand, teamName, codexExec, workerId, interpreter)
        }
    }

    private fun buildWslBashCommand(
        basePath: String,
        role: String,
        scriptPath: String,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false,
        workerId: String = newWorkerId(role),
        interpreter: String? = null
    ): String = buildBashCommand(
        toWslPath(basePath),
        role,
        toWslPath(scriptPath),
        envOverrides.mapValues { (_, v) -> toWslPath(v) },
        agentCommand,
        teamName,
        codexExec,
        workerId,
        interpreter
    )

    internal fun buildCommandForTest(
        basePath: String, role: String, scriptPath: String, kind: ScriptKind, envOverrides: Map<String, String>,
        agentCommand: String, teamName: String?, wslAgents: Boolean, workerId: String, interpreter: String? = null
    ): String = buildCommand(
        basePath, role, ResolvedScript(File(scriptPath), ScriptSource.BUNDLED, kind), envOverrides, agentCommand, teamName,
        wslAgents = wslAgents, workerId = workerId, interpreter = interpreter
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
     * Convert a `powershell -NoProfile ... -EncodedCommand <base64>` line into one that survives a bash prompt:
     * interop needs only the .exe suffix, because base64 holds no `$`, backtick, quote or `!` for bash to expand.
     * Any other line is returned unchanged.
     */
    internal fun bashWrapPowerShell(psLine: String): String =
        if (psLine.startsWith(POWERSHELL_LINE_PREFIX)) "powershell.exe" + psLine.removePrefix("powershell") else psLine

    private fun buildPowerShellCommand(
        basePath: String,
        role: String,
        script: File,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false,
        workerId: String = newWorkerId(role),
        interpreter: String? = null
    ): String {
        requireSafeLaunchArgs(script.absolutePath, basePath, workerId, agentCommand, teamName, envOverrides)
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
        return powerShellLine(
            "${envSet}& $scriptArg -Role $role -Project $projectArg -WorkerId $workerIdArg -Command $commandArg$teamArg$execArg$interactiveArg",
            interpreter ?: "powershell"
        )
    }

    private const val POWERSHELL_LINE_PREFIX = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "

    /**
     * Runs [psCommand] in a fresh `powershell`. The typed line holds only base64 (of UTF-16LE, never UTF_16, which
     * writes a BOM) after the trusted executable and fixed flags, so no argument value reaches the outer shell (PowerShell,
     * cmd, or bash under WSL), nor Windows PowerShell 5.1's native argument passing, which drops a plain `"`. This is
     * the form VS Code's AgentLauncher and AccountsTreeProvider type. [psQuote] still guards the decoded script.
     */
    private fun powerShellLine(psCommand: String, exe: String = "powershell"): String =
        "$exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand " + Base64.getEncoder().encodeToString(psCommand.toByteArray(Charsets.UTF_16LE))

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
        codexExec: Boolean = false,
        workerId: String = newWorkerId(role),
        interpreter: String? = null
    ): String {
        requireSafeLaunchArgs(scriptPath, basePath, workerId, agentCommand, teamName, envOverrides)
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
        val word = interpreter?.let { shQuote(it) } ?: "bash"
        return "$envPrefix$word $scriptArg --role $role --project $projectArg --worker-id $workerIdArg --command $commandArg$teamArg$execArg$interactiveArg"
    }

    // Every word is typed into the shell's line editor: CR/LF end the line, and Ctrl-U or Ctrl-W erase the quoting before them.
    private fun requireSafeArg(label: String, value: String) =
        require(value.none { it < ' ' || it == '\u007f' }) { "Invalid $label: contains control characters" }

    private fun requireSafeLaunchArgs(
        scriptPath: String, basePath: String, workerId: String, agentCommand: String, teamName: String?, envOverrides: Map<String, String>
    ) {
        requireSafeArg("script path", scriptPath)
        requireSafeArg("project path", basePath)
        requireSafeArg("worker id", workerId)
        requireSafeArg("command", agentCommand)
        if (teamName != null) requireSafeArg("team name", teamName)
        envOverrides.forEach { (key, value) -> requireSafeArg("env $key", value) }
    }

    // PowerShell reads ', U+2018, U+2019, U+201A and U+201B as single quotes, so each is doubled: the rule of
    // CodeGeneration.EscapeSingleQuotedStringContent. A doubled pair reads back as one copy of itself.
    private val PS_SINGLE_QUOTE = Regex("['‘’‚‛]")

    private fun psQuote(value: String): String {
        return "'" + value.replace(PS_SINGLE_QUOTE) { it.value + it.value } + "'"
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

    internal fun resolveAgentEnvOverrides(source: ScriptSource): Map<String, String> {
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

    internal fun resolveBundledPath(relative: String): File? {
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

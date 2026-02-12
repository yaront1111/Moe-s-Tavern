package com.moe.services

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.moe.model.ActivityEvent
import com.moe.model.DaemonInfo
import com.moe.model.Epic
import com.moe.model.MoeState
import com.moe.model.Project
import com.moe.model.RailProposal
import com.moe.model.Task
import com.moe.model.Worker
import com.moe.util.MoeJson
import com.moe.util.MoeProjectInitializer
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project as IdeaProject
import com.intellij.openapi.diagnostic.Logger
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.io.File
import java.net.URI
import java.net.InetSocketAddress
import java.net.Socket
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

@Service(Service.Level.PROJECT)
class MoeProjectService(private val project: IdeaProject) : Disposable {
    private val log = Logger.getInstance(MoeProjectService::class.java)
    private val gson = Gson()
    private val listeners = CopyOnWriteArrayList<MoeStateListener>()
    @Volatile private var wsClient: WebSocketClient? = null
    @Volatile private var connected = false
    @Volatile private var state: MoeState? = null
    @Volatile private var lastDaemonStartAttemptAt = 0L
    @Volatile private var connecting = false
    @Volatile private var disposed = false
    @Volatile private var isManualDisconnect = false
    @Volatile private var reconnectAttempts = 0
    @Volatile private var spawnedDaemonProcess: Process? = null
    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "Moe-Refresh").apply { isDaemon = true }
    }
    private var refreshFuture: ScheduledFuture<*>? = null
    private var reconnectFuture: ScheduledFuture<*>? = null
    private val refreshIntervalMs = 3000L
    private val reconnectDelayMs = 5000L
    private val maxReconnectAttempts = 10
    private val daemonStartCooldownMs = 10_000L

    fun connect() {
        if (disposed || connecting || connected) return
        connecting = true
        if (!ensureMoeInitialized()) {
            connecting = false
            publishStatus(false, "Project not initialized")
            return
        }
        val startAttempted = ensureDaemonRunning()

        // If daemon was just started, poll for readiness with backoff
        if (startAttempted) {
            reconnectAttempts = 0  // Reset counter for fresh spawn
            publishStatus(false, "Starting daemon...")
            scheduler.schedule({
                if (disposed) return@schedule
                connectWithRetry(maxAttempts = 10, delayMs = 500)
            }, 500, TimeUnit.MILLISECONDS)
            return
        }

        val daemonInfo = readDaemonInfo() ?: run {
            connecting = false
            publishStatus(false, "Daemon not running. Start with: moe-daemon start")
            scheduleReconnect()
            return
        }
        if (!isProcessAlive(daemonInfo.pid) || !isPortOpen(daemonInfo.port)) {
            // Clean up stale daemon.json so next reconnect can spawn a fresh daemon
            val base = project.basePath
            if (base != null) {
                try {
                    File(base, ".moe/daemon.json").delete()
                    log.info("Removed stale daemon.json in connect() (PID ${daemonInfo.pid} not reachable)")
                } catch (_: Exception) {}
            }
            connecting = false
            publishStatus(false, "Daemon not running, restarting...")
            scheduleReconnect()
            return
        }

        connecting = false
        doConnect(daemonInfo)
    }

    private fun connectWithRetry(maxAttempts: Int, delayMs: Long, attempt: Int = 1) {
        if (disposed || connected) {
            connecting = false
            return
        }

        val daemonInfo = readDaemonInfo()
        if (daemonInfo != null && isProcessAlive(daemonInfo.pid) && isPortOpen(daemonInfo.port)) {
            // Daemon is ready, proceed with connection
            connecting = false
            doConnect(daemonInfo)
            return
        }

        if (attempt >= maxAttempts) {
            connecting = false
            // Kill the daemon we spawned since we couldn't connect to it
            killSpawnedDaemon()
            publishStatus(false, "Daemon failed to start. Check logs.")
            scheduleReconnect()
            return
        }

        publishStatus(false, "Waiting for daemon... (${attempt}/${maxAttempts})")
        scheduler.schedule({
            if (disposed) return@schedule
            connectWithRetry(maxAttempts, delayMs, attempt + 1)
        }, delayMs, TimeUnit.MILLISECONDS)
    }

    private fun doConnect(daemonInfo: DaemonInfo) {
        if (disposed || connected || connecting) return
        connecting = true

        val uri = URI("ws://127.0.0.1:${daemonInfo.port}/ws")
        wsClient = object : WebSocketClient(uri) {
            override fun onOpen(handshakedata: ServerHandshake?) {
                connecting = false
                connected = true
                reconnectAttempts = 0
                isManualDisconnect = false
                publishStatus(true, "Connected")
                sendMessage("GET_STATE", JsonObject())
                startAutoRefresh()
            }

            override fun onMessage(message: String?) {
                if (message == null) return
                try {
                    handleMessage(message)
                } catch (ex: Exception) {
                    publishStatus(false, ex.message ?: "Failed to parse state")
                }
            }

            override fun onClose(code: Int, reason: String?, remote: Boolean) {
                connecting = false
                connected = false
                wsClient = null
                stopAutoRefresh()
                publishStatus(false, reason ?: "Disconnected")
                scheduleReconnect()
            }

            override fun onError(ex: Exception?) {
                connecting = false
                connected = false
                wsClient = null
                stopAutoRefresh()
                publishStatus(false, ex?.message ?: "WebSocket error")
                scheduleReconnect()
            }
        }

        try {
            wsClient?.connect()
        } catch (ex: Exception) {
            log.warn("WebSocket connect() failed", ex)
            connecting = false
            connected = false
            wsClient = null
            publishStatus(false, ex.message ?: "Failed to connect")
            scheduleReconnect()
        }
    }

    fun disconnect() {
        isManualDisconnect = true
        reconnectAttempts = 0
        stopAutoRefresh()
        reconnectFuture?.cancel(false)
        reconnectFuture = null
        wsClient?.close()
        wsClient = null
        connected = false
        connecting = false
    }

    fun addListener(listener: MoeStateListener) {
        if (disposed) {
            log.warn("Attempted to add listener to disposed service")
            return
        }
        // Prevent duplicate listeners
        if (!listeners.contains(listener)) {
            listeners.add(listener)
        }
    }

    fun removeListener(listener: MoeStateListener) {
        listeners.remove(listener)
    }

    /**
     * Returns the current number of registered listeners.
     * Useful for debugging memory leaks.
     */
    fun getListenerCount(): Int = listeners.size

    private fun handleMessage(message: String) {
        val json = gson.fromJson(message, JsonObject::class.java)
        val type = json.get("type")?.asString ?: return

        when (type) {
            "STATE_SNAPSHOT" -> {
                val payload = json.getAsJsonObject("payload")
                val newState = MoeJson.parseState(payload)
                state = newState
                publishState(newState)
            }
            "TASK_UPDATED", "TASK_CREATED" -> {
                val payload = json.getAsJsonObject("payload")
                val task = MoeJson.parseTask(payload)
                val current = state ?: return
                val oldTask = current.tasks.find { it.id == task.id }
                val tasks = current.tasks.filter { it.id != task.id } + task
                val newState = current.copy(tasks = tasks)
                state = newState
                publishState(newState)

                // Send notifications for status changes (must run on EDT)
                if (oldTask?.status != task.status) {
                    val newStatus = task.status
                    ApplicationManager.getApplication().invokeLater {
                        val notificationService = MoeNotificationService.getInstance(project)
                        when (newStatus) {
                            "AWAITING_APPROVAL" -> notificationService.notifyAwaitingApproval(task)
                            "BLOCKED" -> notificationService.notifyTaskBlocked(task)
                            "REVIEW" -> notificationService.notifyTaskInReview(task)
                            "DONE" -> notificationService.notifyTaskCompleted(task)
                        }
                    }
                }
            }
            "TASK_DELETED" -> {
                val payload = json.getAsJsonObject("payload")
                val task = MoeJson.parseTask(payload)
                val current = state ?: return
                val tasks = current.tasks.filter { it.id != task.id }
                val newState = current.copy(tasks = tasks)
                state = newState
                publishState(newState)
            }
            "EPIC_UPDATED", "EPIC_CREATED" -> {
                val payload = json.getAsJsonObject("payload")
                val epic = MoeJson.parseEpic(payload)
                val current = state ?: return
                val epics = current.epics.filter { it.id != epic.id } + epic
                val newState = current.copy(epics = epics)
                state = newState
                publishState(newState)
            }
            "EPIC_DELETED" -> {
                val payload = json.getAsJsonObject("payload")
                val epic = MoeJson.parseEpic(payload)
                val current = state ?: return
                val epics = current.epics.filter { it.id != epic.id }
                val tasks = current.tasks.filter { it.epicId != epic.id }
                val newState = current.copy(epics = epics, tasks = tasks)
                state = newState
                publishState(newState)
            }
            "ERROR" -> {
                val errorMessage = json.get("message")?.asString ?: "Unknown error"
                val operation = json.get("operation")?.asString ?: "unknown"
                publishError(operation, errorMessage)
            }
            "ACTIVITY_LOG" -> {
                val payload = json.get("payload")
                    ?.takeIf { it.isJsonArray }
                    ?.asJsonArray
                    ?: return
                val events = MoeJson.parseActivityEvents(payload)
                publishActivityLog(events)
            }
            "PROPOSAL_UPDATED", "PROPOSAL_CREATED" -> {
                val payload = json.getAsJsonObject("payload")
                val proposal = MoeJson.parseProposal(payload)
                val current = state ?: return
                val proposals = current.proposals.filter { it.id != proposal.id } + proposal
                val newState = current.copy(proposals = proposals)
                state = newState
                publishState(newState)
            }
            "WORKER_UPDATED", "WORKER_CREATED" -> {
                val payload = json.getAsJsonObject("payload")
                val worker = MoeJson.parseWorker(payload)
                val current = state ?: return
                val workers = current.workers.filter { it.id != worker.id } + worker
                val newState = current.copy(workers = workers)
                state = newState
                publishState(newState)
            }
            "TEAM_CREATED", "TEAM_UPDATED" -> {
                val payload = json.getAsJsonObject("payload")
                val team = MoeJson.parseTeam(payload)
                val current = state ?: return
                val teams = current.teams.filter { it.id != team.id } + team
                val newState = current.copy(teams = teams)
                state = newState
                publishState(newState)
            }
            "TEAM_DELETED" -> {
                val payload = json.getAsJsonObject("payload")
                val team = MoeJson.parseTeam(payload)
                val current = state ?: return
                val teams = current.teams.filter { it.id != team.id }
                val newState = current.copy(teams = teams)
                state = newState
                publishState(newState)
            }
        }
    }

    private fun ensureConnected(): Boolean {
        if (!connected || wsClient == null) {
            log.warn("Operation attempted without active connection")
            publishStatus(false, "Not connected to daemon")
            return false
        }
        return true
    }

    fun updateTaskStatus(taskId: String, status: String, order: Double) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            add("updates", JsonObject().apply {
                addProperty("status", status)
                addProperty("order", order)
            })
        }
        sendMessage("UPDATE_TASK", payload)
    }

    fun updateTaskDetails(taskId: String, title: String, description: String, definitionOfDone: List<String>? = null, priority: String? = null) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            add("updates", JsonObject().apply {
                addProperty("title", title)
                addProperty("description", description)
                if (definitionOfDone != null) {
                    val array = JsonArray()
                    definitionOfDone.forEach { array.add(it) }
                    add("definitionOfDone", array)
                }
                if (priority != null) {
                    addProperty("priority", priority)
                }
            })
        }
        sendMessage("UPDATE_TASK", payload)
    }

    fun deleteTask(taskId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("taskId", taskId) }
        sendMessage("DELETE_TASK", payload)
    }

    fun deleteEpic(epicId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("epicId", epicId) }
        sendMessage("DELETE_EPIC", payload)
    }

    fun updateSettings(settings: com.moe.model.ProjectSettings) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("approvalMode", settings.approvalMode)
            addProperty("speedModeDelayMs", settings.speedModeDelayMs)
            addProperty("autoCreateBranch", settings.autoCreateBranch)
            addProperty("branchPattern", settings.branchPattern)
            addProperty("commitPattern", settings.commitPattern)
            addProperty("agentCommand", settings.agentCommand)
        }
        sendMessage("UPDATE_SETTINGS", payload)
    }

    fun updateEpicStatus(epicId: String, status: String, order: Double) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("epicId", epicId)
            add("updates", JsonObject().apply {
                addProperty("status", status)
                addProperty("order", order)
            })
        }
        sendMessage("UPDATE_EPIC", payload)
    }

    fun updateEpicDetails(epicId: String, title: String, description: String, architectureNotes: String, epicRails: List<String>, status: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("epicId", epicId)
            add("updates", JsonObject().apply {
                addProperty("title", title)
                addProperty("description", description)
                addProperty("architectureNotes", architectureNotes)
                val railsArray = JsonArray()
                epicRails.forEach { railsArray.add(it) }
                add("epicRails", railsArray)
                addProperty("status", status)
            })
        }
        sendMessage("UPDATE_EPIC", payload)
    }

    fun approveTask(taskId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("taskId", taskId) }
        sendMessage("APPROVE_TASK", payload)
    }

    fun rejectTask(taskId: String, reason: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            addProperty("reason", reason)
        }
        sendMessage("REJECT_TASK", payload)
    }

    fun reopenTask(taskId: String, reason: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            addProperty("reason", reason)
        }
        sendMessage("REOPEN_TASK", payload)
    }

    fun addTaskComment(taskId: String, content: String) {
        if (!ensureConnected()) return
        val trimmed = content.trim()
        if (trimmed.isEmpty()) return
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            addProperty("content", trimmed)
        }
        sendMessage("ADD_TASK_COMMENT", payload)
    }

    fun archiveDoneTasks(epicId: String? = null) {
        if (!ensureConnected()) return
        val payload = JsonObject()
        if (epicId != null) {
            payload.addProperty("epicId", epicId)
        }
        sendMessage("ARCHIVE_DONE_TASKS", payload)
    }

    fun createTask(epicId: String, title: String, description: String, definitionOfDone: List<String>, priority: String = "MEDIUM") {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("epicId", epicId)
            addProperty("title", title)
            addProperty("description", description)
            addProperty("priority", priority)
            val array = JsonArray()
            definitionOfDone.forEach { array.add(it) }
            add("definitionOfDone", array)
        }
        sendMessage("CREATE_TASK", payload)
    }

    fun createEpic(title: String, description: String, architectureNotes: String = "", epicRails: List<String> = emptyList()) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("title", title)
            addProperty("description", description)
            addProperty("architectureNotes", architectureNotes)
            val railsArray = JsonArray()
            epicRails.forEach { railsArray.add(it) }
            add("epicRails", railsArray)
        }
        sendMessage("CREATE_EPIC", payload)
    }

    private fun sendMessage(type: String, payload: JsonObject) {
        val client = wsClient ?: return
        if (!client.isOpen) {
            log.debug("Cannot send message '$type': WebSocket not open")
            return
        }
        val message = JsonObject().apply {
            addProperty("type", type)
            add("payload", payload)
        }
        try {
            client.send(message.toString())
        } catch (ex: Exception) {
            log.debug("Failed to send message '$type': ${ex.message}")
            // Connection likely dropped; let reconnect handle it.
        }
    }

    private fun publishState(state: MoeState) {
        ApplicationManager.getApplication().invokeLater {
            listeners.forEach { it.onState(state) }
        }
    }

    private fun publishStatus(isConnected: Boolean, message: String) {
        ApplicationManager.getApplication().invokeLater {
            listeners.forEach { it.onStatus(isConnected, message) }
        }
    }

    private fun publishError(operation: String, message: String) {
        ApplicationManager.getApplication().invokeLater {
            listeners.forEach { it.onError(operation, message) }
        }
    }

    private fun publishActivityLog(events: List<ActivityEvent>) {
        ApplicationManager.getApplication().invokeLater {
            listeners.forEach { it.onActivityLog(events) }
        }
    }

    fun requestActivityLog(limit: Int = 100) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("limit", limit) }
        sendMessage("GET_ACTIVITY_LOG", payload)
    }

    fun approveProposal(proposalId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("proposalId", proposalId) }
        sendMessage("APPROVE_PROPOSAL", payload)
    }

    fun rejectProposal(proposalId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("proposalId", proposalId) }
        sendMessage("REJECT_PROPOSAL", payload)
    }

    private fun readDaemonInfo(): DaemonInfo? {
        val base = project.basePath ?: return null
        val file = File(base, ".moe/daemon.json")
        if (!file.exists()) return null
        return try {
            gson.fromJson(file.readText(), DaemonInfo::class.java)
        } catch (ex: Exception) {
            log.debug("Failed to read daemon.json: ${ex.message}")
            null
        }
    }

    fun ensureDaemonRunning(): Boolean {
        if (!ensureMoeInitialized()) {
            return false
        }

        val info = readDaemonInfo()
        if (info != null && isProcessAlive(info.pid) && isPortOpen(info.port)) {
            return false
        }

        // Clean up stale daemon.json so connectWithRetry reads fresh data from the new daemon
        if (info != null) {
            val base = project.basePath
            if (base != null) {
                try {
                    File(base, ".moe/daemon.json").delete()
                    log.info("Removed stale daemon.json (PID ${info.pid} not running)")
                } catch (ex: Exception) {
                    log.debug("Failed to remove stale daemon.json: ${ex.message}")
                }
            }
        }

        val now = System.currentTimeMillis()
        if (now - lastDaemonStartAttemptAt < daemonStartCooldownMs) {
            return false
        }
        lastDaemonStartAttemptAt = now

        val basePath = project.basePath ?: return false
        val direct = buildDirectDaemonCommand(basePath)

        try {
            val pb = if (direct != null) {
                ProcessBuilder(direct)
            } else {
                val command = buildDaemonCommand(basePath)
                if (isWindows()) {
                    ProcessBuilder("cmd", "/c", command)
                } else {
                    ProcessBuilder("bash", "-lc", command)
                }
            }
            pb.redirectErrorStream(true)
            val nodeDir = direct?.firstOrNull()?.let { File(it).parentFile }
            if (nodeDir != null) {
                val env = pb.environment()
                val current = env["PATH"] ?: ""
                env["PATH"] = "${nodeDir.absolutePath}${File.pathSeparator}$current"
            }
            val process = pb.start()
            spawnedDaemonProcess = process
            // Drain stdout/stderr to prevent Windows pipe deadlock (buffer is ~4KB)
            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { /* discard */ }
                } catch (_: Exception) { }
            }, "Moe-DaemonDrain").apply { isDaemon = true }.start()
            log.info("Started Moe daemon for $basePath using ${direct?.joinToString(" ") ?: "shell command"} (pid tracking enabled)")
            return true
        } catch (ex: Exception) {
            log.warn("Failed to start Moe daemon", ex)
            publishStatus(false, ex.message ?: "Failed to start daemon")
            return false
        }
    }

    private fun ensureMoeInitialized(): Boolean {
        val basePath = project.basePath ?: return false
        val moeDir = File(basePath, ".moe")
        if (!moeDir.exists()) {
            return try {
                MoeProjectInitializer.initializeProject(basePath, project.name)
                log.info("Initialized .moe folder for project at $basePath")
                true
            } catch (ex: Exception) {
                log.warn("Failed to initialize .moe folder: ${ex.message}")
                false
            }
        }
        return true
    }

    private fun buildDaemonCommand(basePath: String): String {
        val raw = System.getenv("MOE_DAEMON_COMMAND")?.trim()
        if (!raw.isNullOrBlank()) {
            val normalized = raw.trim().trim('"')
            if (raw.contains("{projectPath}")) {
                return raw.replace("{projectPath}", basePath)
            }
            val hasProject = raw.contains("--project")
            if (!hasProject) {
                val needsStart = normalized.endsWith(".cmd", true) ||
                    normalized.endsWith(".ps1", true) ||
                    normalized.endsWith(".js", true) ||
                    normalized.equals("moe-daemon", true)
                val withStart = if (needsStart && !raw.contains(" start")) "$raw start" else raw
                return "$withStart --project \"$basePath\""
            }
            return raw
        }

        val installed = resolveInstalledDaemonCommand(basePath)
        if (installed != null) {
            return installed
        }

        return "moe-daemon start --project \"$basePath\""
    }

    private fun buildDirectDaemonCommand(basePath: String): List<String>? {
        val script = resolveLocalDaemonScript(basePath) ?: return null
        val node = resolveNodeExecutable() ?: "node"
        return listOf(node, script.absolutePath, "start", "--project", basePath)
    }

    private fun resolveLocalDaemonScript(basePath: String): File? {
        val startDir = File(basePath)
        return findInParents(startDir, "packages/moe-daemon/dist/index.js")
            ?: findInParents(startDir, "moe-daemon/dist/index.js")
            ?: resolveBundledDaemonScript()
            ?: resolveGlobalConfigDaemonScript()
    }

    private fun resolveGlobalConfigDaemonScript(): File? {
        val installPath = com.moe.util.MoeProjectRegistry.readGlobalInstallPath() ?: return null
        val candidate = File(installPath, "packages${File.separator}moe-daemon${File.separator}dist${File.separator}index.js")
        return if (candidate.exists()) {
            log.debug("Using daemon from global config: ${candidate.absolutePath}")
            candidate
        } else null
    }

    private fun resolveBundledDaemonScript(): File? {
        return try {
            val plugin = PluginManagerCore.getPlugin(PluginId.getId("com.moe.jetbrains"))
            val pluginRoot = plugin?.pluginPath?.toFile()
            val fromPlugin = pluginRoot?.let { File(it, "daemon/index.js") }
            if (fromPlugin != null && fromPlugin.exists()) {
                log.debug("Using bundled daemon from plugin path: ${fromPlugin.absolutePath}")
                return fromPlugin
            }

            val codeSource = MoeProjectService::class.java.protectionDomain?.codeSource?.location?.toURI()
            val jarFile = codeSource?.let { File(it) }
            val inferredRoot = jarFile?.parentFile?.parentFile
            val fromJar = inferredRoot?.let { File(it, "daemon/index.js") }
            if (fromJar != null && fromJar.exists()) {
                log.debug("Using bundled daemon from jar path: ${fromJar.absolutePath}")
                return fromJar
            }

            null
        } catch (ex: Exception) {
            log.debug("Failed to resolve bundled daemon script: ${ex.message}")
            null
        }
    }

    private fun findInParents(start: File, relative: String, maxDepth: Int = 5): File? {
        var dir: File? = start
        var depth = 0
        while (dir != null && depth <= maxDepth) {
            val candidate = File(dir, relative)
            if (candidate.exists()) {
                return candidate
            }
            dir = dir.parentFile
            depth += 1
        }
        return null
    }

    private fun resolveNodeExecutable(): String? {
        val env = System.getenv("MOE_NODE_COMMAND")?.trim()
        if (!env.isNullOrBlank()) {
            return env.trim('"')
        }
        if (isWindows()) {
            val programFiles = System.getenv("ProgramFiles")
            val programFilesX86 = System.getenv("ProgramFiles(x86)")
            val localAppData = System.getenv("LOCALAPPDATA")
            val appData = System.getenv("APPDATA")
            val candidates = listOfNotNull(
                programFiles?.let { File(it, "nodejs\\node.exe") },
                programFilesX86?.let { File(it, "nodejs\\node.exe") },
                localAppData?.let { File(it, "Programs\\nodejs\\node.exe") },
                localAppData?.let { File(it, "nvm\\current\\node.exe") },
                appData?.let { File(it, "nvm\\node.exe") }
            )
            val found = candidates.firstOrNull { it.exists() }?.absolutePath
            if (found != null) return found
            return findNodeFromWhere()
        }
        // macOS / Linux: check common node locations since ProcessBuilder
        // does not inherit the user's shell PATH when launched from the IDE
        val home = System.getProperty("user.home")
        val macLinuxCandidates = listOfNotNull(
            File("/opt/homebrew/bin/node"),         // Homebrew ARM (Apple Silicon)
            File("/usr/local/bin/node"),             // Homebrew Intel / system
            home?.let { File(it, ".nvm/current/bin/node") },
            home?.let { File(it, ".nvm/versions/node").listFiles()
                ?.filter { d -> d.isDirectory }
                ?.maxByOrNull { d -> d.name }
                ?.let { d -> File(d, "bin/node") }
            },
            File("/usr/bin/node")
        )
        val found = macLinuxCandidates.firstOrNull { it.exists() }?.absolutePath
        if (found != null) {
            log.debug("Resolved node on macOS/Linux: $found")
            return found
        }
        return findNodeViaWhich()
    }

    private fun findNodeFromWhere(): String? {
        var process: Process? = null
        return try {
            process = ProcessBuilder("where", "node")
                .redirectErrorStream(true)
                .start()
            val completed = process.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
            if (!completed) {
                process.destroyForcibly()
                return null
            }
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            val line = reader.readLine()?.trim()
            reader.close()
            if (!line.isNullOrBlank()) line else null
        } catch (ex: Exception) {
            log.debug("Failed to find node via 'where' command", ex)
            null
        } finally {
            process?.destroyForcibly()
        }
    }

    private fun findNodeViaWhich(): String? {
        var process: Process? = null
        return try {
            process = ProcessBuilder("which", "node")
                .redirectErrorStream(true)
                .start()
            val completed = process.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
            if (!completed) {
                process.destroyForcibly()
                return null
            }
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            val line = reader.readLine()?.trim()
            reader.close()
            if (!line.isNullOrBlank()) line else null
        } catch (ex: Exception) {
            log.debug("Failed to find node via 'which' command", ex)
            null
        } finally {
            process?.destroyForcibly()
        }
    }

    private fun resolveInstalledDaemonCommand(basePath: String): String? {
        if (!isWindows()) return null
        val roots = listOf("ProgramFiles", "ProgramFiles(x86)")
            .mapNotNull { System.getenv(it) }
        for (root in roots) {
            val cmd = File(root, "Moe\\moe-daemon\\start-daemon.cmd")
            if (cmd.exists()) {
                return "\"${cmd.absolutePath}\" start --project \"$basePath\""
            }
        }
        return null
    }

    private fun isWindows(): Boolean {
        return System.getProperty("os.name").lowercase().contains("win")
    }

    private fun isProcessAlive(pid: Int): Boolean {
        return try {
            val handle = ProcessHandle.of(pid.toLong())
            handle.isPresent && handle.get().isAlive
        } catch (ex: Exception) {
            log.debug("Failed to check process $pid: ${ex.message}")
            false
        }
    }

    private fun isPortOpen(port: Int): Boolean {
        val socket = Socket()
        return try {
            socket.connect(InetSocketAddress("127.0.0.1", port), PORT_CHECK_TIMEOUT_MS)
            true
        } catch (_: Exception) {
            false
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
                // Ignore close errors
            }
        }
    }

    override fun dispose() {
        if (disposed) return
        disposed = true
        log.info("Disposing MoeProjectService")

        // Cancel any pending reconnect
        reconnectFuture?.cancel(true)
        reconnectFuture = null

        // Stop auto-refresh
        stopAutoRefresh()

        // Disconnect WebSocket
        disconnect()

        // Clear all listeners to prevent memory leaks
        listeners.clear()

        // Shutdown scheduler gracefully
        try {
            scheduler.shutdown()
            if (!scheduler.awaitTermination(2, TimeUnit.SECONDS)) {
                scheduler.shutdownNow()
            }
        } catch (ex: InterruptedException) {
            scheduler.shutdownNow()
            Thread.currentThread().interrupt()
        } catch (ex: Exception) {
            log.warn("Error shutting down scheduler: ${ex.message}")
            scheduler.shutdownNow()
        }

        // Kill any spawned daemon process we started
        killSpawnedDaemon()

        // Clear state
        state = null
    }

    /**
     * Kill the daemon process we spawned if it's still running.
     * This is called on dispose or if startup fails.
     */
    private fun killSpawnedDaemon() {
        val process = spawnedDaemonProcess ?: return
        spawnedDaemonProcess = null
        try {
            if (process.isAlive) {
                log.info("Killing spawned daemon process")
                process.destroy()
                // Give it a moment to terminate gracefully
                if (!process.waitFor(2, TimeUnit.SECONDS)) {
                    process.destroyForcibly()
                }
            }
        } catch (ex: Exception) {
            log.warn("Error killing spawned daemon: ${ex.message}")
        }
    }

    private fun startAutoRefresh() {
        if (disposed || refreshFuture != null) return
        refreshFuture = scheduler.scheduleAtFixedRate({
            if (disposed || !connected) return@scheduleAtFixedRate
            try {
                sendMessage("GET_STATE", JsonObject())
            } catch (ex: Exception) {
                log.debug("Auto-refresh failed: ${ex.message}")
            }
        }, refreshIntervalMs, refreshIntervalMs, TimeUnit.MILLISECONDS)
    }

    private fun stopAutoRefresh() {
        refreshFuture?.cancel(false)
        refreshFuture = null
    }

    private fun scheduleReconnect() {
        if (disposed || connected || connecting) return
        if (isManualDisconnect) return
        if (reconnectAttempts >= maxReconnectAttempts) {
            publishStatus(false, "Reconnect failed after $maxReconnectAttempts attempts")
            return
        }
        val existing = reconnectFuture
        if (existing != null && !existing.isDone) return
        reconnectAttempts++
        publishStatus(false, "Reconnecting... (${reconnectAttempts}/${maxReconnectAttempts})")
        reconnectFuture = scheduler.schedule({
            if (disposed || connected || connecting || isManualDisconnect) return@schedule
            connect()
        }, reconnectDelayMs, TimeUnit.MILLISECONDS)
    }

    fun getState(): MoeState? = state

    fun getDaemonInfo(): DaemonInfo? = readDaemonInfo()

    fun isConnected(): Boolean = connected

    fun restartDaemon() {
        disconnect()
        val base = project.basePath
        if (base != null) {
            val info = readDaemonInfo()
            if (info != null) {
                // Kill existing daemon if alive
                if (isProcessAlive(info.pid)) {
                    try {
                        ProcessHandle.of(info.pid.toLong()).ifPresent { it.destroy() }
                    } catch (_: Exception) {}
                }
                try {
                    File(base, ".moe/daemon.json").delete()
                } catch (_: Exception) {}
            }
        }
        lastDaemonStartAttemptAt = 0  // Reset cooldown
        reconnectAttempts = 0
        connect()
    }

    companion object {
        // Configurable timeout for port check (can be overridden via system property)
        private val PORT_CHECK_TIMEOUT_MS: Int = System.getProperty("moe.portCheckTimeoutMs")?.toIntOrNull() ?: 200

        fun getInstance(project: IdeaProject): MoeProjectService {
            return project.getService(MoeProjectService::class.java)
        }
    }
}

interface MoeStateListener {
    fun onState(state: MoeState)
    fun onStatus(connected: Boolean, message: String)
    fun onError(operation: String, message: String) {}
    fun onActivityLog(events: List<ActivityEvent>) {}
}

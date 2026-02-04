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
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
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
    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "Moe-Refresh").apply { isDaemon = true }
    }
    private var refreshFuture: ScheduledFuture<*>? = null
    private var reconnectFuture: ScheduledFuture<*>? = null
    private val refreshIntervalMs = 3000L
    private val reconnectDelayMs = 2000L
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
        val daemonInfo = readDaemonInfo() ?: run {
            connecting = false
            publishStatus(
                false,
                if (startAttempted) "Starting daemon..." else "Daemon not running. Start with: moe-daemon start"
            )
            scheduleReconnect()
            return
        }
        if (!isProcessAlive(daemonInfo.pid) || !isPortOpen(daemonInfo.port)) {
            connecting = false
            publishStatus(
                false,
                if (startAttempted) "Starting daemon..." else "Daemon not running. Start with: moe-daemon start"
            )
            scheduleReconnect()
            return
        }

        val uri = URI("ws://127.0.0.1:${daemonInfo.port}/ws")
        wsClient = object : WebSocketClient(uri) {
            override fun onOpen(handshakedata: ServerHandshake?) {
                connecting = false
                connected = true
                publishStatus(true, "Connected")
                // Request state snapshot explicitly in case the server sent it before handlers were ready.
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

        wsClient?.connect()
    }

    fun disconnect() {
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

                // Send notifications for status changes
                if (oldTask?.status != task.status) {
                    val notificationService = MoeNotificationService.getInstance(project)
                    when (task.status) {
                        "AWAITING_APPROVAL" -> notificationService.notifyAwaitingApproval(task)
                        "BLOCKED" -> notificationService.notifyTaskBlocked(task)
                        "REVIEW" -> notificationService.notifyTaskInReview(task)
                        "DONE" -> notificationService.notifyTaskCompleted(task)
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
        }
    }

    fun updateTaskStatus(taskId: String, status: String, order: Double) {
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            add("updates", JsonObject().apply {
                addProperty("status", status)
                addProperty("order", order)
            })
        }
        sendMessage("UPDATE_TASK", payload)
    }

    fun updateTaskDetails(taskId: String, title: String, description: String, definitionOfDone: List<String>? = null) {
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
            })
        }
        sendMessage("UPDATE_TASK", payload)
    }

    fun deleteTask(taskId: String) {
        val payload = JsonObject().apply { addProperty("taskId", taskId) }
        sendMessage("DELETE_TASK", payload)
    }

    fun deleteEpic(epicId: String) {
        val payload = JsonObject().apply { addProperty("epicId", epicId) }
        sendMessage("DELETE_EPIC", payload)
    }

    fun updateSettings(settings: com.moe.model.ProjectSettings) {
        val payload = JsonObject().apply {
            addProperty("approvalMode", settings.approvalMode)
            addProperty("speedModeDelayMs", settings.speedModeDelayMs)
            addProperty("autoCreateBranch", settings.autoCreateBranch)
            addProperty("branchPattern", settings.branchPattern)
            addProperty("commitPattern", settings.commitPattern)
        }
        sendMessage("UPDATE_SETTINGS", payload)
    }

    fun updateEpicStatus(epicId: String, status: String, order: Double) {
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
        val payload = JsonObject().apply { addProperty("taskId", taskId) }
        sendMessage("APPROVE_TASK", payload)
    }

    fun rejectTask(taskId: String, reason: String) {
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            addProperty("reason", reason)
        }
        sendMessage("REJECT_TASK", payload)
    }

    fun reopenTask(taskId: String, reason: String) {
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            addProperty("reason", reason)
        }
        sendMessage("REOPEN_TASK", payload)
    }

    fun createTask(epicId: String, title: String, description: String, definitionOfDone: List<String>) {
        val payload = JsonObject().apply {
            addProperty("epicId", epicId)
            addProperty("title", title)
            addProperty("description", description)
            val array = JsonArray()
            definitionOfDone.forEach { array.add(it) }
            add("definitionOfDone", array)
        }
        sendMessage("CREATE_TASK", payload)
    }

    fun createEpic(title: String, description: String, architectureNotes: String = "", epicRails: List<String> = emptyList()) {
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
        val payload = JsonObject().apply { addProperty("limit", limit) }
        sendMessage("GET_ACTIVITY_LOG", payload)
    }

    fun approveProposal(proposalId: String) {
        val payload = JsonObject().apply { addProperty("proposalId", proposalId) }
        sendMessage("APPROVE_PROPOSAL", payload)
    }

    fun rejectProposal(proposalId: String) {
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
            pb.start()
            log.info("Started Moe daemon for $basePath using ${direct?.joinToString(" ") ?: "shell command"}")
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
        if (!isWindows()) return null
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
            socket.connect(InetSocketAddress("127.0.0.1", port), 200)
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

        // Clear state
        state = null
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
        val existing = reconnectFuture
        if (existing != null && !existing.isDone) return
        reconnectFuture = scheduler.schedule({
            if (disposed || connected || connecting) return@schedule
            connect()
        }, reconnectDelayMs, TimeUnit.MILLISECONDS)
    }
}

interface MoeStateListener {
    fun onState(state: MoeState)
    fun onStatus(connected: Boolean, message: String)
    fun onError(operation: String, message: String) {}
    fun onActivityLog(events: List<ActivityEvent>) {}
}

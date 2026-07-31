package com.moe.services

import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.DaemonInfo
import com.moe.model.MoeState
import com.moe.util.MoeDaemonRegistrationTracker
import com.moe.util.MoeProjectRegistry
import com.moe.util.TerminalAgentLauncher
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.io.File
import java.net.URI
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

@Service(Service.Level.PROJECT)
class MoeProjectService @JvmOverloads constructor(
    private val project: IdeaProject,
    private val invokeLaterForTests: ((() -> Unit) -> Unit)? = null
) : Disposable {
    private val log = Logger.getInstance(MoeProjectService::class.java)
    private val daemonSupervisor = MoeDaemonSupervisor(
        basePath = project.basePath.orEmpty(),
        projectName = project.name,
        onStatus = ::publishStatus,
        wslAgentsEnabled = { TerminalAgentLauncher.isWslAgentsEnabled(project) }
    )
    private val wsLock = ReentrantLock()
    private val messageQueue = ConcurrentLinkedQueue<String>()
    @Volatile private var wsClient: WebSocketClient? = null
    @Volatile private var connected = false
    @Volatile private var state: MoeState? = null
    @Volatile private var connecting = false
    private val disposed = AtomicBoolean(false)
    private val messageDispatcher = MoeMessageDispatcher(
        project = project,
        invokeLater = ::invokeLater,
        isDisposed = { disposed.get() },
        currentState = { state },
        updateState = { state = it },
        onProjectMismatch = {
            disconnect()
            wsLock.withLock { isManualDisconnect = false }
            scheduleReconnect()
        },
        onDaemonShuttingDown = {
            isManualDisconnect = true
            stopAutoRefresh()
        }
    )
    private val commandSender = MoeCommandSender(
        connectedCheck = { connected && wsClient != null },
        onDisconnected = { publishStatus(false, "Not connected to daemon") },
        send = send@{ type, message ->
            val client = wsClient ?: return@send
            if (!client.isOpen) {
                log.debug("Cannot send message '$type': WebSocket not open")
                return@send
            }
            client.send(message)
        }
    )
    @Volatile private var isManualDisconnect = false
    @Volatile private var reconnectAttempts = 0
    private val daemonRegistration = MoeDaemonRegistrationTracker(
        register = { pid -> MoeProjectRegistry.registerDaemon(pid) },
        unregister = { pid -> MoeProjectRegistry.unregisterDaemon(pid) },
        logError = { message, ex -> log.warn(message, ex) }
    )
    private val connectedDaemonPid: Int?
        get() = daemonRegistration.currentPid
    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "Moe-Refresh").apply { isDaemon = true }
    }
    private var refreshFuture: ScheduledFuture<*>? = null
    @Volatile private var reconnectFuture: ScheduledFuture<*>? = null
    @Volatile private var retryFuture: ScheduledFuture<*>? = null
    private val refreshIntervalMs = 3000L
    private val reconnectDelayMs = 5000L
    private val maxReconnectAttempts = 10
    // Generous startup ceiling: while the daemon we spawned is still alive but not
    // yet listening, keep polling (with capped backoff) up to this many attempts so a
    // slow cold start is not mistaken for a failure and killed prematurely.
    private val maxStartupAttempts = 40
    private val maxRetryDelayMs = 2000L

    private fun invokeLater(action: () -> Unit) {
        val testDispatcher = invokeLaterForTests
        if (testDispatcher != null) {
            testDispatcher(action)
        } else {
            ApplicationManager.getApplication().invokeLater(action)
        }
    }

    fun connect() {
        if (disposed.get()) return
        // Atomic check-and-set: the open-listener and a pooled panel init can both
        // race here, so guard the connecting/connected flags under wsLock instead of
        // a non-atomic check-then-set on the @Volatile flags.
        wsLock.withLock {
            if (connecting || connected) return
            connecting = true
        }
        isManualDisconnect = false
        if (!daemonSupervisor.ensureMoeInitialized()) {
            connecting = false
            publishStatus(false, "Project not initialized")
            return
        }
        val startAttempted = ensureDaemonRunning()

        // If daemon was just started, poll for readiness with backoff
        if (startAttempted) {
            publishStatus(false, "Starting daemon...")
            scheduleRetryAttempt(maxAttempts = 10, delayMs = 500, attempt = 1)
            return
        }

        val daemonInfo = daemonSupervisor.readDaemonInfo() ?: run {
            connecting = false
            publishStatus(false, "Daemon not running. Start with: moe-daemon start")
            scheduleReconnect()
            return
        }
        if (!daemonSupervisor.isProcessAlive(daemonInfo.pid) || !daemonSupervisor.isPortOpen(daemonInfo.port)) {
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
        if (disposed.get() || connected) {
            connecting = false
            retryFuture = null
            return
        }

        val daemonInfo = daemonSupervisor.readDaemonInfo()
        if (daemonInfo != null && daemonSupervisor.isProcessAlive(daemonInfo.pid) && daemonSupervisor.isPortOpen(daemonInfo.port)) {
            // Daemon is ready, proceed with connection
            connecting = false
            retryFuture = null
            doConnect(daemonInfo)
            return
        }

        val spawned = daemonSupervisor.spawnedProcess()
        val spawnedAlive = spawned != null && spawned.isAlive

        if (spawnedAlive) {
            // The daemon we spawned is up but not yet listening: it is STILL STARTING,
            // not failed. Don't destroy a process that's making progress toward binding
            // its port just because the initial poll window elapsed. Reset the spawn cap
            // so a future reconnect is never permanently disabled, and keep polling with
            // a capped backoff up to a generous startup ceiling.
            daemonSupervisor.resetSpawnAttempts()
            if (attempt < maxStartupAttempts) {
                val nextDelay = (delayMs * 2).coerceAtMost(maxRetryDelayMs)
                publishStatus(false, "Starting daemon... (${attempt}/${maxStartupAttempts})")
                scheduleRetryAttempt(maxStartupAttempts, nextDelay, attempt + 1)
                return
            }
            // Alive but never bound within the generous window: treat as hung and give up.
        } else if (attempt < maxAttempts) {
            // No live spawned process yet (external daemon coming up, or daemon.json not
            // written): keep the original short budget before declaring failure.
            publishStatus(false, "Waiting for daemon... (${attempt}/${maxAttempts})")
            scheduleRetryAttempt(maxAttempts, delayMs, attempt + 1)
            return
        }

        // The spawned process died, or the startup ceiling was exhausted: fail.
        connecting = false
        retryFuture = null
        // Kill the daemon we spawned since we couldn't connect to it
        daemonSupervisor.killSpawnedDaemon()
        publishStatus(false, "Daemon failed to start. Check logs.")
        scheduleReconnect()
    }

    private fun scheduleRetryAttempt(maxAttempts: Int, delayMs: Long, attempt: Int) {
        try {
            retryFuture?.cancel(false)
        } catch (ex: Exception) {
            log.debug("Failed to cancel existing retry future: ${ex.message}", ex)
        } finally {
            retryFuture = null
        }

        try {
            retryFuture = scheduler.schedule({
                retryFuture = null
                if (disposed.get() || connected) return@schedule
                connectWithRetry(maxAttempts, delayMs, attempt)
            }, delayMs, TimeUnit.MILLISECONDS)
        } catch (ex: Exception) {
            connecting = false
            log.warn("Failed to schedule retry attempt", ex)
            publishStatus(false, "Failed to schedule reconnect retry")
        }
    }

    private fun doConnect(daemonInfo: DaemonInfo) {
        if (disposed.get() || connected || connecting) return
        connecting = true

        // Synchronize the client swap to prevent races with callbacks
        val newClient: WebSocketClient
        wsLock.withLock {
            val oldClient = wsClient
            wsClient = null
            closeQuietly(oldClient)

            val uri = URI("ws://127.0.0.1:${daemonInfo.port}/ws")
            newClient = object : WebSocketClient(uri) {
                override fun onOpen(handshakedata: ServerHandshake?) {
                    wsLock.withLock {
                        connecting = false
                        connected = true
                        reconnectAttempts = 0
                        daemonSupervisor.resetSpawnAttempts()
                        isManualDisconnect = false
                        daemonRegistration.register(daemonInfo.pid)
                    }
                    publishStatus(true, "Connected")
                    // Drain any messages queued during reconnect
                    while (true) {
                        val queued = messageQueue.poll() ?: break
                        try { handleMessage(queued) } catch (ex: Exception) {
                            log.warn("Failed to process queued message", ex)
                        }
                    }
                    sendMessage("GET_STATE", JsonObject())
                    startAutoRefresh()
                }

                override fun onMessage(message: String?) {
                    if (message == null) return
                    val isStale = wsLock.withLock { wsClient !== this }
                    if (isStale) {
                        log.debug("Ignoring onMessage from stale WebSocket client")
                        return
                    }
                    try {
                        handleMessage(message)
                    } catch (ex: Exception) {
                        publishStatus(false, ex.message ?: "Failed to parse state")
                    }
                }

                override fun onClose(code: Int, reason: String?, remote: Boolean) {
                    wsLock.withLock {
                        if (wsClient === this) {
                            connecting = false
                            connected = false
                            wsClient = null
                            stopAutoRefresh()
                        } else {
                            log.debug("Ignoring onClose from stale WebSocket client")
                            return
                        }
                    }
                    publishStatus(false, reason ?: "Disconnected")
                    scheduleReconnect()
                }

                override fun onError(ex: Exception?) {
                    wsLock.withLock {
                        if (wsClient === this) {
                            connecting = false
                            connected = false
                            wsClient = null
                            stopAutoRefresh()
                        } else {
                            log.debug("Ignoring onError from stale WebSocket client")
                            return
                        }
                    }
                    publishStatus(false, ex?.message ?: "WebSocket error")
                    scheduleReconnect()
                }
            }
            wsClient = newClient
        }

        try {
            newClient.connect()
        } catch (ex: Exception) {
            log.warn("WebSocket connect() failed", ex)
            wsLock.withLock {
                connecting = false
                connected = false
                closeQuietly(wsClient)
                wsClient = null
            }
            publishStatus(false, ex.message ?: "Failed to connect")
            scheduleReconnect()
        }
    }

    fun disconnect() {
        disconnect(notifyStatus = true)
    }

    private fun disconnect(notifyStatus: Boolean) {
        isManualDisconnect = true
        reconnectAttempts = 0
        stopAutoRefresh()
        cancelConnectionTimers()
        val currentClient = wsLock.withLock {
            val client = wsClient
            wsClient = null
            connected = false
            connecting = false
            client
        }
        closeQuietly(currentClient)
        if (notifyStatus) {
            publishStatus(false, "Disconnected")
        }
    }

    private fun cancelConnectionTimers() {
        try {
            reconnectFuture?.cancel(false)
        } catch (ex: Exception) {
            log.debug("Failed to cancel reconnect future: ${ex.message}", ex)
        } finally {
            reconnectFuture = null
        }

        try {
            retryFuture?.cancel(false)
        } catch (ex: Exception) {
            log.debug("Failed to cancel retry future: ${ex.message}", ex)
        } finally {
            retryFuture = null
        }
    }

    fun addListener(listener: MoeStateListener) = messageDispatcher.addListener(listener)

    fun removeListener(listener: MoeStateListener) = messageDispatcher.removeListener(listener)

    fun getListenerCount(): Int = messageDispatcher.getListenerCount()

    private fun handleMessage(message: String) = messageDispatcher.handle(message)

    private fun publishStatus(isConnected: Boolean, message: String) =
        messageDispatcher.publishStatus(isConnected, message)

    private fun publishError(operation: String, message: String) =
        messageDispatcher.publishError(operation, message)

    fun updateTaskStatus(taskId: String, status: String, order: Double) =
        commandSender.updateTaskStatus(taskId, status, order)

    fun updateTaskDetails(taskId: String, title: String, description: String, definitionOfDone: List<String>? = null, priority: String? = null) =
        commandSender.updateTaskDetails(taskId, title, description, definitionOfDone, priority)

    fun deleteTask(taskId: String) = commandSender.deleteTask(taskId)

    fun deleteEpic(epicId: String) = commandSender.deleteEpic(epicId)

    fun updateSettings(settings: com.moe.model.ProjectSettings) = commandSender.updateSettings(settings)

    fun updateEpicStatus(epicId: String, status: String, order: Double) =
        commandSender.updateEpicStatus(epicId, status, order)

    fun updateEpicDetails(epicId: String, title: String, description: String, architectureNotes: String, epicRails: List<String>, status: String) =
        commandSender.updateEpicDetails(epicId, title, description, architectureNotes, epicRails, status)

    fun approveTask(taskId: String) = commandSender.approveTask(taskId)

    fun releaseTask(taskId: String, reason: String? = null) = commandSender.releaseTask(taskId, reason)

    fun rejectTask(taskId: String, reason: String) = commandSender.rejectTask(taskId, reason)

    fun reopenTask(taskId: String, reason: String) = commandSender.reopenTask(taskId, reason)

    fun addTaskComment(taskId: String, content: String) = commandSender.addTaskComment(taskId, content)

    fun archiveDoneTasks(epicId: String? = null) = commandSender.archiveDoneTasks(epicId)

    fun createTask(epicId: String, title: String, description: String, definitionOfDone: List<String>, priority: String = "MEDIUM") =
        commandSender.createTask(epicId, title, description, definitionOfDone, priority)

    fun createEpic(title: String, description: String, architectureNotes: String = "", epicRails: List<String> = emptyList()) =
        commandSender.createEpic(title, description, architectureNotes, epicRails)

    fun requestChannels() = commandSender.requestChannels()

    fun requestMessages(channel: String, limit: Int = 50, sinceId: String? = null) =
        commandSender.requestMessages(channel, limit, sinceId)

    fun sendChatMessage(channel: String, content: String) = commandSender.sendChatMessage(channel, content)

    fun requestPins(channel: String) = commandSender.requestPins(channel)

    fun pinMessage(channel: String, messageId: String) = commandSender.pinMessage(channel, messageId)

    fun unpinMessage(channel: String, messageId: String) = commandSender.unpinMessage(channel, messageId)

    fun togglePinDone(channel: String, messageId: String) = commandSender.togglePinDone(channel, messageId)

    fun requestDecisions() = commandSender.requestDecisions()

    fun approveDecision(decisionId: String) = commandSender.approveDecision(decisionId)

    fun rejectDecision(decisionId: String) = commandSender.rejectDecision(decisionId)

    fun requestActivityLog(limit: Int = 100) = commandSender.requestActivityLog(limit)

    fun requestMetrics(epicId: String? = null, sinceIso: String? = null, limit: Int? = null) =
        commandSender.requestMetrics(epicId, sinceIso, limit)

    fun approveProposal(proposalId: String) = commandSender.approveProposal(proposalId)

    fun rejectProposal(proposalId: String) = commandSender.rejectProposal(proposalId)

    private fun sendMessage(type: String, payload: JsonObject) = commandSender.sendMessage(type, payload)

    private fun closeQuietly(client: WebSocketClient?) {
        if (client == null) return
        try {
            client.close()
        } catch (ex: Exception) {
            log.debug("Failed to close old WebSocket client", ex)
        }
    }

    override fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        log.info("Disposing MoeProjectService")

        // Cancel any pending reconnect
        cancelConnectionTimers()

        // Stop auto-refresh
        stopAutoRefresh()

        // Disconnect WebSocket (disconnect uses closeQuietly for safe cleanup)
        disconnect(notifyStatus = false)

        // Clear all listeners to prevent memory leaks
        messageDispatcher.clearListeners()

        // Stop accepting new scheduled work immediately (non-blocking).
        scheduler.shutdown()

        // Decide daemon ownership synchronously so the ref-count drops right away,
        // but defer the blocking awaitTermination + daemon kill (each up to ~2s) off
        // the EDT so disposing the tool window never freezes the UI.
        val pid = connectedDaemonPid
        val killDaemon: Boolean = if (pid != null) {
            val isLastUser = daemonRegistration.unregisterCurrent()
            if (!isLastUser) {
                log.info("Daemon PID $pid still in use by other projects, not killing")
                daemonSupervisor.releaseSpawnedProcessReference() // Don't hold the process reference
            }
            isLastUser
        } else {
            true
        }

        val teardown = Runnable {
            try {
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
            if (killDaemon) {
                daemonSupervisor.killSpawnedDaemon()
            }
        }

        val app = ApplicationManager.getApplication()
        if (app != null) {
            app.executeOnPooledThread(teardown)
        } else {
            // No platform application (e.g. headless unit tests): run inline.
            teardown.run()
        }

        // Clear state
        state = null
    }



    private fun startAutoRefresh() {
        if (disposed.get() || refreshFuture != null) return
        refreshFuture = scheduler.scheduleAtFixedRate({
            if (disposed.get() || !connected) return@scheduleAtFixedRate
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
        if (disposed.get() || connected || connecting) return
        if (isManualDisconnect) return
        if (reconnectAttempts >= maxReconnectAttempts) {
            publishStatus(false, "Reconnect failed after $maxReconnectAttempts attempts")
            return
        }
        try {
            reconnectFuture?.cancel(false)
        } catch (ex: Exception) {
            log.debug("Failed to cancel existing reconnect future: ${ex.message}", ex)
        } finally {
            reconnectFuture = null
        }
        reconnectAttempts++
        publishStatus(false, "Reconnecting... (${reconnectAttempts}/${maxReconnectAttempts})")
        reconnectFuture = scheduler.schedule({
            if (disposed.get() || connected || connecting || isManualDisconnect) return@schedule
            connect()
        }, reconnectDelayMs, TimeUnit.MILLISECONDS)
    }

    fun ensureDaemonRunning(): Boolean = daemonSupervisor.ensureDaemonRunning()

    fun getState(): MoeState? = state

    fun getDaemonInfo(): DaemonInfo? = daemonSupervisor.readDaemonInfo()

    fun isConnected(): Boolean = connected

    fun restartDaemon() {
        disconnect()
        val base = project.basePath
        if (base != null) {
            val info = daemonSupervisor.readDaemonInfo()
            if (info != null) {
                // Kill existing daemon if alive
                if (daemonSupervisor.isProcessAlive(info.pid)) {
                    try {
                        ProcessHandle.of(info.pid.toLong()).ifPresent { it.destroy() }
                    } catch (_: Exception) {}
                }
                try {
                    File(base, ".moe/daemon.json").delete()
                } catch (_: Exception) {}
            }
        }
        daemonSupervisor.resetSpawnBackoff()
        reconnectAttempts = 0
        connect()
    }

    companion object {

        fun getInstance(project: IdeaProject): MoeProjectService {
            return project.getService(MoeProjectService::class.java)
        }
    }
}

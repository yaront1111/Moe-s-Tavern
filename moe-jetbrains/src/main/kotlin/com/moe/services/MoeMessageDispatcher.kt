package com.moe.services

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.ActivityEvent
import com.moe.model.ChatMessage
import com.moe.model.Decision
import com.moe.model.MetricsAggregate
import com.moe.model.MoeState
import com.moe.model.PinEntry
import com.moe.util.MoeJson
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

class MoeMessageDispatcher(
    private val project: IdeaProject,
    private val invokeLater: ((() -> Unit) -> Unit),
    private val isDisposed: () -> Boolean,
    private val currentState: () -> MoeState?,
    private val updateState: (MoeState) -> Unit,
    private val onProjectMismatch: () -> Unit,
    private val onDaemonShuttingDown: () -> Unit
) {
    private val log = Logger.getInstance(MoeMessageDispatcher::class.java)
    private val gson = Gson()
    private val listeners = CopyOnWriteArrayList<MoeStateListener>()

    /** Safe asString that handles both Kotlin null and Gson JsonNull. */
    private fun JsonElement?.safeAsString(): String? =
        if (this == null || this.isJsonNull) null else this.asString

    fun addListener(listener: MoeStateListener) {
        if (isDisposed()) {
            log.warn("Attempted to add listener to disposed service")
            return
        }
        if (!listeners.contains(listener)) {
            listeners.add(listener)
        }
    }

    fun removeListener(listener: MoeStateListener) {
        listeners.remove(listener)
    }

    fun getListenerCount(): Int = listeners.size

    fun clearListeners() {
        listeners.clear()
    }

    private fun applyMessageOnEdt(messageType: String, action: () -> Unit) {
        invokeLater {
            try {
                if (isDisposed()) {
                    log.debug("Ignoring $messageType because service is disposed")
                    return@invokeLater
                }
                action()
            } catch (ex: Exception) {
                log.warn("Failed to apply $messageType on EDT: ${ex.message}", ex)
                publishError(messageType, ex.message ?: "Failed to apply message")
            }
        }
    }

    fun handle(message: String) {
        val json = gson.fromJson(message, JsonObject::class.java)
        val type = json.get("type").safeAsString() ?: return

        when (type) {
            "STATE_SNAPSHOT" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val newState = MoeJson.parseState(payload)
                val basePath = project.basePath
                if (basePath != null && newState.project.rootPath.isNotEmpty()) {
                    try {
                        val daemonPath = File(newState.project.rootPath).canonicalPath
                        val expectedPath = File(basePath).canonicalPath
                        if (daemonPath != expectedPath) {
                            log.warn("STATE_SNAPSHOT project mismatch: expected $expectedPath, got $daemonPath. Disconnecting.")
                            val daemonJson = File(basePath, ".moe/daemon.json")
                            try { daemonJson.delete() } catch (_: Exception) {}
                            onProjectMismatch()
                            return
                        }
                    } catch (_: java.io.IOException) {
                        log.debug("Could not resolve canonical paths for project mismatch check, skipping")
                    }
                }
                applyMessageOnEdt(type) {
                    updateState(newState)
                    publishState(newState)
                }
            }
            "TASK_UPDATED", "TASK_CREATED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val task = MoeJson.parseTask(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }

                    val oldTask = current.tasks.find { it.id == task.id }
                    // STATE_SNAPSHOT strips ARCHIVED tasks; mirror that here so an archived
                    // task does not linger in the cache until the next refresh (see TASK_DELETED).
                    val tasks = if (task.status == "ARCHIVED") {
                        current.tasks.filter { it.id != task.id }
                    } else {
                        current.tasks.filter { it.id != task.id } + task
                    }
                    val newState = current.copy(tasks = tasks)
                    updateState(newState)
                    publishState(newState)

                    if (oldTask?.status != task.status) {
                        val newStatus = task.status
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
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val task = MoeJson.parseTask(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val tasks = current.tasks.filter { it.id != task.id }
                    val newState = current.copy(tasks = tasks)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "EPIC_UPDATED", "EPIC_CREATED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val epic = MoeJson.parseEpic(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val epics = current.epics.filter { it.id != epic.id } + epic
                    val newState = current.copy(epics = epics)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "EPIC_DELETED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val epic = MoeJson.parseEpic(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val epics = current.epics.filter { it.id != epic.id }
                    val tasks = current.tasks.filter { it.epicId != epic.id }
                    val newState = current.copy(epics = epics, tasks = tasks)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "ERROR" -> {
                val errorMessage = json.get("message").safeAsString() ?: "Unknown error"
                val operation = json.get("operation").safeAsString() ?: "unknown"
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
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val proposal = MoeJson.parseProposal(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val proposals = current.proposals.filter { it.id != proposal.id } + proposal
                    val newState = current.copy(proposals = proposals)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "PROPOSAL_DELETED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val proposal = MoeJson.parseProposal(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val proposals = current.proposals.filter { it.id != proposal.id }
                    val newState = current.copy(proposals = proposals)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "WORKER_UPDATED", "WORKER_CREATED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val worker = MoeJson.parseWorker(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val workers = current.workers.filter { it.id != worker.id } + worker
                    val newState = current.copy(workers = workers)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "WORKER_DELETED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val worker = MoeJson.parseWorker(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val workers = current.workers.filter { it.id != worker.id }
                    val newState = current.copy(workers = workers)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "TEAM_CREATED", "TEAM_UPDATED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val team = MoeJson.parseTeam(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val teams = current.teams.filter { it.id != team.id } + team
                    val newState = current.copy(teams = teams)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "TEAM_DELETED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val team = MoeJson.parseTeam(payload)
                applyMessageOnEdt(type) {
                    val current = currentState()
                    if (current == null) {
                        log.debug("Ignoring $type message because state is not initialized")
                        return@applyMessageOnEdt
                    }
                    val teams = current.teams.filter { it.id != team.id }
                    val newState = current.copy(teams = teams)
                    updateState(newState)
                    publishState(newState)
                }
            }
            "CHANNELS" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val channelsArray = payload.get("channels")?.takeIf { it.isJsonArray }?.asJsonArray ?: return
                try {
                    val channels = channelsArray.map { MoeJson.parseChannel(it.asJsonObject) }
                    applyMessageOnEdt(type) {
                        val current = currentState() ?: return@applyMessageOnEdt
                        val newState = current.copy(channels = channels)
                        updateState(newState)
                        publishState(newState)
                    }
                } catch (e: Exception) {
                    log.warn("Failed to parse CHANNELS payload", e)
                }
            }
            "MESSAGES" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val channel = payload.get("channel").safeAsString() ?: return
                val messagesArray = payload.get("messages")?.takeIf { it.isJsonArray }?.asJsonArray ?: return
                try {
                    val messages = messagesArray.map { MoeJson.parseChatMessage(it.asJsonObject) }
                    publishChatMessages(channel, messages)
                } catch (e: Exception) {
                    log.warn("Failed to parse MESSAGES payload", e)
                }
            }
            "MESSAGE_SENT" -> {
                // MESSAGE_SENT is the direct response to sender; MESSAGE_CREATED broadcast handles all UI updates
            }
            "MESSAGE_CREATED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                try {
                    val message = MoeJson.parseChatMessage(payload)
                    publishChatMessage(message)
                } catch (e: Exception) {
                    log.warn("Failed to parse MESSAGE_CREATED payload", e)
                }
            }
            "CHANNEL_CREATED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                try {
                    val channel = MoeJson.parseChannel(payload)
                    applyMessageOnEdt(type) {
                        val current = currentState()
                        if (current == null) {
                            log.debug("Ignoring $type message because state is not initialized")
                            return@applyMessageOnEdt
                        }
                        val channels = current.channels.filter { it.id != channel.id } + channel
                        val newState = current.copy(channels = channels)
                        updateState(newState)
                        publishState(newState)
                    }
                } catch (e: Exception) {
                    log.warn("Failed to parse CHANNEL_CREATED payload", e)
                }
            }
            "CHANNEL_DELETED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                try {
                    val channel = MoeJson.parseChannel(payload)
                    applyMessageOnEdt(type) {
                        val current = currentState()
                        if (current == null) {
                            log.debug("Ignoring $type message because state is not initialized")
                            return@applyMessageOnEdt
                        }
                        val channels = current.channels.filter { it.id != channel.id }
                        val newState = current.copy(channels = channels)
                        updateState(newState)
                        publishState(newState)
                    }
                } catch (e: Exception) {
                    log.warn("Failed to parse CHANNEL_DELETED payload", e)
                }
            }
            "PINS" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val channel = payload.get("channel").safeAsString() ?: return
                val pinsArray = payload.get("pins")?.takeIf { it.isJsonArray }?.asJsonArray ?: return
                try {
                    val pins = pinsArray.map { MoeJson.parsePinEntry(it.asJsonObject) }
                    publishPins(channel, pins)
                } catch (e: Exception) {
                    log.warn("Failed to parse PINS payload", e)
                }
            }
            "PIN_CREATED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val channel = payload.get("channel").safeAsString() ?: return
                val pinObj = payload.get("pin")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                try {
                    val pin = MoeJson.parsePinEntry(pinObj)
                    publishPinCreated(channel, pin)
                } catch (e: Exception) {
                    log.warn("Failed to parse PIN_CREATED payload", e)
                }
            }
            "PIN_REMOVED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val channel = payload.get("channel").safeAsString() ?: return
                val messageId = payload.get("messageId").safeAsString() ?: return
                publishPinRemoved(channel, messageId)
            }
            "PIN_TOGGLED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val channel = payload.get("channel").safeAsString() ?: return
                val pinObj = payload.get("pin")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                try {
                    val pin = MoeJson.parsePinEntry(pinObj)
                    publishPinToggled(channel, pin)
                } catch (e: Exception) {
                    log.warn("Failed to parse PIN_TOGGLED payload", e)
                }
            }
            "DECISIONS" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                val decisionsArray = payload.get("decisions")?.takeIf { it.isJsonArray }?.asJsonArray ?: return
                try {
                    val decisions = decisionsArray.map { MoeJson.parseDecision(it.asJsonObject) }
                    publishDecisions(decisions)
                } catch (e: Exception) {
                    log.warn("Failed to parse DECISIONS payload", e)
                }
            }
            "DECISION_PROPOSED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                try {
                    val decision = MoeJson.parseDecision(payload)
                    publishDecisionProposed(decision)
                } catch (e: Exception) {
                    log.warn("Failed to parse DECISION_PROPOSED payload", e)
                }
            }
            "DECISION_RESOLVED" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                try {
                    val decision = MoeJson.parseDecision(payload)
                    publishDecisionResolved(decision)
                } catch (e: Exception) {
                    log.warn("Failed to parse DECISION_RESOLVED payload", e)
                }
            }
            "METRICS" -> {
                val payload = json.get("payload")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
                try {
                    val aggregate = MoeJson.parseMetricsAggregate(payload)
                    publishMetrics(aggregate)
                } catch (e: Exception) {
                    log.warn("Failed to parse METRICS payload", e)
                }
            }
            "DAEMON_SHUTTING_DOWN" -> {
                if (isDisposed()) return
                onDaemonShuttingDown()
                publishStatus(false, "Daemon shutting down...")
            }
        }
    }

    private fun publishState(state: MoeState) {
        invokeLater {
            listeners.forEach { it.onState(state) }
        }
    }

    fun publishStatus(isConnected: Boolean, message: String) {
        invokeLater {
            listeners.forEach { it.onStatus(isConnected, message) }
        }
    }

    fun publishError(operation: String, message: String) {
        invokeLater {
            listeners.forEach { it.onError(operation, message) }
        }
    }

    private fun publishChatMessage(message: ChatMessage) {
        invokeLater {
            listeners.forEach { it.onChatMessage(message) }
        }
    }

    private fun publishChatMessages(channel: String, messages: List<ChatMessage>) {
        invokeLater {
            listeners.forEach { it.onChatMessages(channel, messages) }
        }
    }

    private fun publishPins(channel: String, pins: List<PinEntry>) {
        invokeLater {
            listeners.forEach { it.onPins(channel, pins) }
        }
    }

    private fun publishPinCreated(channel: String, pin: PinEntry) {
        invokeLater {
            listeners.forEach { it.onPinCreated(channel, pin) }
        }
    }

    private fun publishPinRemoved(channel: String, messageId: String) {
        invokeLater {
            listeners.forEach { it.onPinRemoved(channel, messageId) }
        }
    }

    private fun publishPinToggled(channel: String, pin: PinEntry) {
        invokeLater {
            listeners.forEach { it.onPinToggled(channel, pin) }
        }
    }

    private fun publishDecisions(decisions: List<Decision>) {
        invokeLater {
            listeners.forEach { it.onDecisions(decisions) }
        }
    }

    private fun publishDecisionProposed(decision: Decision) {
        invokeLater {
            listeners.forEach { it.onDecisionProposed(decision) }
        }
    }

    private fun publishDecisionResolved(decision: Decision) {
        invokeLater {
            listeners.forEach { it.onDecisionResolved(decision) }
        }
    }

    private fun publishActivityLog(events: List<ActivityEvent>) {
        invokeLater {
            listeners.forEach { it.onActivityLog(events) }
        }
    }

    private fun publishMetrics(aggregate: MetricsAggregate) {
        invokeLater {
            listeners.forEach { it.onMetrics(aggregate) }
        }
    }
}

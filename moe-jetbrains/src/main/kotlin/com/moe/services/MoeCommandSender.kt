package com.moe.services

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import com.moe.model.ProjectSettings

class MoeCommandSender(
    private val connectedCheck: () -> Boolean,
    private val onDisconnected: () -> Unit,
    private val send: (String, String) -> Unit
) {
    private val log = Logger.getInstance(MoeCommandSender::class.java)

    private fun ensureConnected(): Boolean {
        if (!connectedCheck()) {
            log.warn("Operation attempted without active connection")
            onDisconnected()
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
    fun updateSettings(settings: ProjectSettings) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("approvalMode", settings.approvalMode)
            addProperty("speedModeDelayMs", settings.speedModeDelayMs)
            addProperty("autoCreateBranch", settings.autoCreateBranch)
            addProperty("branchPattern", settings.branchPattern)
            addProperty("commitPattern", settings.commitPattern)
            addProperty("agentCommand", settings.agentCommand)
            addProperty("enableAgentTeams", settings.enableAgentTeams)
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
    fun releaseTask(taskId: String, reason: String? = null) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            if (!reason.isNullOrBlank()) {
                addProperty("reason", reason)
            }
        }
        sendMessage("RELEASE_TASK", payload)
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
    fun requestChannels() {
        if (!ensureConnected()) return
        sendMessage("GET_CHANNELS", JsonObject())
    }
    fun requestMessages(channel: String, limit: Int = 50, sinceId: String? = null) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("channel", channel)
            addProperty("limit", limit)
            if (sinceId != null) {
                addProperty("sinceId", sinceId)
            }
        }
        sendMessage("GET_MESSAGES", payload)
    }
    fun sendChatMessage(channel: String, content: String) {
        if (!ensureConnected()) return
        val trimmed = content.trim()
        if (trimmed.isEmpty()) return
        val payload = JsonObject().apply {
            addProperty("channel", channel)
            addProperty("content", trimmed)
        }
        sendMessage("SEND_MESSAGE", payload)
    }
    fun requestPins(channel: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("channel", channel) }
        sendMessage("GET_PINS", payload)
    }
    fun pinMessage(channel: String, messageId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("channel", channel)
            addProperty("messageId", messageId)
        }
        sendMessage("PIN_MESSAGE", payload)
    }
    fun unpinMessage(channel: String, messageId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("channel", channel)
            addProperty("messageId", messageId)
        }
        sendMessage("UNPIN_MESSAGE", payload)
    }
    fun togglePinDone(channel: String, messageId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("channel", channel)
            addProperty("messageId", messageId)
        }
        sendMessage("TOGGLE_PIN_DONE", payload)
    }
    fun requestDecisions() {
        if (!ensureConnected()) return
        sendMessage("GET_DECISIONS", JsonObject())
    }
    fun approveDecision(decisionId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("decisionId", decisionId) }
        sendMessage("APPROVE_DECISION", payload)
    }
    fun rejectDecision(decisionId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("decisionId", decisionId) }
        sendMessage("REJECT_DECISION", payload)
    }
    fun sendMessage(type: String, payload: JsonObject) {
        val message = JsonObject().apply {
            addProperty("type", type)
            add("payload", payload)
        }
        try {
            send(type, message.toString())
        } catch (ex: Exception) {
            log.debug("Failed to send message '$type': ${ex.message}")
            // Connection likely dropped; let reconnect handle it.
        }
    }

    fun requestActivityLog(limit: Int = 100) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("limit", limit) }
        sendMessage("GET_ACTIVITY_LOG", payload)
    }

    /**
     * Request aggregated metrics from the daemon. The daemon agent is wiring
     * the underlying `moe.list_metrics` tool; this client sends `GET_METRICS`
     * with the same payload shape and listens for `METRICS` responses.
     *
     * Safe to call before the daemon supports it — request is dropped silently
     * if not connected, and a missing response simply leaves the metrics tab
     * empty.
     */
    fun requestMetrics(epicId: String? = null, sinceIso: String? = null, limit: Int? = null) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            if (epicId != null) addProperty("epicId", epicId)
            if (sinceIso != null) addProperty("sinceIso", sinceIso)
            if (limit != null) addProperty("limit", limit)
        }
        sendMessage("GET_METRICS", payload)
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
}

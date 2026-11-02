package com.moe.services

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import com.moe.model.MAX_SAFE_PLAN_REVISION
import com.moe.model.ProjectSettings

/**
 * Builds the daemon command envelopes.
 *
 * [send] reports whether the local transport accepted the bytes; it never
 * reports daemon acceptance. Only [approveTask] and [updateSettings] report
 * that result (and fire [onDisconnected] when it is false), and only
 * [approveTask] lets a transport failure escape — every other command keeps
 * the historical best-effort behaviour of [sendMessage], because they are also
 * driven from connection and background callbacks that must not start throwing.
 */
class MoeCommandSender(
    private val connectedCheck: () -> Boolean,
    private val onDisconnected: () -> Unit,
    private val send: (String, String) -> Boolean
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
    /**
     * @return true only when the local socket accepted the UPDATE_SETTINGS bytes
     *   (never daemon acceptance). false means nothing reached the socket (not
     *   connected, refused or a throwing transport) and [onDisconnected] has
     *   fired exactly once. A throwing transport is reported, never rethrown.
     */
    fun updateSettings(settings: ProjectSettings): Boolean {
        if (!ensureConnected()) return false
        val payload = JsonObject().apply {
            addProperty("approvalMode", settings.approvalMode)
            addProperty("speedModeDelayMs", settings.speedModeDelayMs)
            addProperty("agentCommand", settings.agentCommand)
            addProperty("enableAgentTeams", settings.enableAgentTeams)
        }
        val delivered = sendMessage("UPDATE_SETTINGS", payload)
        if (!delivered) onDisconnected()
        return delivered
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
    /**
     * Approves [taskId], quoting the required plan revision that was reviewed.
     *
     * CQ-F MODIFY_RAIL prop-5e7763ed (human-approved 2026-10-25) removes
     * token-free approvals. [expectedPlanRevision], including an explicit 0
     * for a stamp-less task, is always sent unchanged. The caller must pass the
     * revision it actually reviewed rather than a fresher one read from state.
     *
     * @return true only when the local socket accepted the bytes. That is NOT
     *   daemon approval; the task flips only when the daemon says so. false means
     *   the command never left this process and [onDisconnected] has fired once.
     * @throws IllegalArgumentException when [expectedPlanRevision] is outside
     *   `0..MAX_SAFE_PLAN_REVISION`. Nothing is sent in that case.
     */
    fun approveTask(taskId: String, expectedPlanRevision: Long): Boolean {
        require(expectedPlanRevision in 0L..MAX_SAFE_PLAN_REVISION) {
            "expectedPlanRevision must be in 0..$MAX_SAFE_PLAN_REVISION, was $expectedPlanRevision"
        }
        if (!ensureConnected()) return false
        val payload = JsonObject().apply {
            addProperty("taskId", taskId)
            addProperty("expectedPlanRevision", expectedPlanRevision)
        }
        val delivered = dispatch("APPROVE_TASK", payload)
        if (!delivered) onDisconnected()
        return delivered
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
    /**
     * Deregisters a seat whose terminal this IDE lost. Quiet when disconnected
     * (no status flap): it also runs from tab disposal while a project closes,
     * and [AgentSeatTracker] re-sends at the next connect until the daemon acks.
     */
    fun deregisterWorker(workerId: String, reason: String) {
        if (!connectedCheck()) return
        val payload = JsonObject().apply {
            addProperty("workerId", workerId)
            addProperty("reason", reason)
        }
        sendMessage("DEREGISTER_WORKER", payload)
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
    /**
     * Builds the `{type,payload}` envelope and hands it to the transport.
     * Deliberately unchecked: the caller decides whether a transport failure is
     * best-effort noise or an error the user must see.
     */
    private fun dispatch(type: String, payload: JsonObject): Boolean {
        val message = JsonObject().apply {
            addProperty("type", type)
            add("payload", payload)
        }
        return send(type, message.toString())
    }

    /** Best-effort send: never throws. Returns whether the transport accepted the bytes; background callers ignore it. */
    fun sendMessage(type: String, payload: JsonObject): Boolean {
        return try {
            dispatch(type, payload)
        } catch (ex: Exception) {
            log.debug("Failed to send message '$type': ${ex.message}")
            // Connection likely dropped; let reconnect handle it.
            false
        }
    }

    /**
     * Sends CLIENT_HELLO, once per socket (a second hello is refused
     * CLIENT_CAPABILITIES_LOCKED). It declares only what this plugin honors.
     * planRevisions is required: after any hello the daemon refuses approvals
     * without it (WebSocketServer.ts assertApprovalCapabilities), and
     * [approveTask] and the board drag already send expectedPlanRevision.
     * Best-effort and quiet: no ensureConnected, never throws.
     */
    fun sendClientHello(): Boolean {
        val payload = JsonObject().apply {
            addProperty("protocolVersion", 1)
            add("capabilities", JsonObject().apply {
                addProperty("planRevisions", true)
                addProperty("verifiedLocal", true)
            })
        }
        return sendMessage("CLIENT_HELLO", payload)
    }

    /**
     * Sends GET_EXECUTION_READINESS {refresh:true}. Best-effort and quiet: the
     * caller checks the connection itself, so a probe publishes no status.
     */
    fun requestExecutionReadiness(): Boolean =
        sendMessage("GET_EXECUTION_READINESS", JsonObject().apply { addProperty("refresh", true) })

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
    /**
     * Registers a new Claude account. A blank [label] is left out, so the daemon
     * labels the account with its id. The daemon answers this connection with
     * ACCOUNT_ADDED, then broadcasts ACCOUNTS_UPDATED.
     */
    fun addAccount(label: String?) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            val trimmed = label?.trim()
            if (!trimmed.isNullOrEmpty()) addProperty("label", trimmed)
        }
        sendMessage("ADD_ACCOUNT", payload)
    }
    /** Unregisters the account only; its Claude login stays in its folder. */
    fun removeAccount(accountId: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("accountId", accountId) }
        sendMessage("REMOVE_ACCOUNT", payload)
    }
    /** Moves the account one place earlier (-1) or later (1) in the order Moe uses the accounts. */
    fun moveAccount(accountId: String, offset: Int) {
        require(offset == -1 || offset == 1) { "offset must be -1 or 1, was $offset" }
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("accountId", accountId)
            addProperty("offset", offset)
        }
        sendMessage("MOVE_ACCOUNT", payload)
    }
    fun renameAccount(accountId: String, label: String) {
        if (!ensureConnected()) return
        val payload = JsonObject().apply {
            addProperty("accountId", accountId)
            addProperty("label", label.trim())
        }
        sendMessage("RENAME_ACCOUNT", payload)
    }
    /** Sets the usage percent at which workers move to the next account after their current step. */
    fun setAccountSwitchPercent(percent: Int) {
        require(percent in 1..100) { "switchAtPercent must be in 1..100, was $percent" }
        if (!ensureConnected()) return
        val payload = JsonObject().apply { addProperty("switchAtPercent", percent) }
        sendMessage("SET_ACCOUNT_SWITCH_PERCENT", payload)
    }
}

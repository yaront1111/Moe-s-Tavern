package com.moe.services

import com.moe.model.ActivityEvent
import com.moe.model.ChatMessage
import com.moe.model.Decision
import com.moe.model.MetricsAggregate
import com.moe.model.MoeState
import com.moe.model.PinEntry

/**
 * A daemon ERROR frame with its correlation fields. Each field is null when the
 * frame lacks it or carries a non-string, so a hostile value never correlates.
 */
data class DaemonError(
    val operation: String?,
    val codeName: String?,
    val taskId: String?,
    val message: String
)

interface MoeStateListener {
    fun onState(state: MoeState)
    fun onStatus(connected: Boolean, message: String)
    fun onError(operation: String, message: String) {}
    /** Delivered AFTER [onError] for every daemon ERROR frame. */
    fun onDaemonError(error: DaemonError) {}
    fun onActivityLog(events: List<ActivityEvent>) {}
    fun onChatMessage(message: ChatMessage) {}
    fun onChatMessages(channel: String, messages: List<ChatMessage>) {}
    fun onPins(channel: String, pins: List<PinEntry>) {}
    fun onPinCreated(channel: String, pin: PinEntry) {}
    fun onPinRemoved(channel: String, messageId: String) {}
    fun onPinToggled(channel: String, pin: PinEntry) {}
    fun onDecisions(decisions: List<Decision>) {}
    fun onDecisionProposed(decision: Decision) {}
    fun onDecisionResolved(decision: Decision) {}
    fun onMetrics(aggregate: MetricsAggregate) {}
    /** The daemon registered the account this connection asked for with ADD_ACCOUNT. */
    fun onAccountAdded(accountId: String) {}
}

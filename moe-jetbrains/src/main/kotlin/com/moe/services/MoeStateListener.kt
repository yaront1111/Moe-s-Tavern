package com.moe.services

import com.moe.model.ActivityEvent
import com.moe.model.ChatMessage
import com.moe.model.Decision
import com.moe.model.MetricsAggregate
import com.moe.model.MoeState
import com.moe.model.PinEntry

interface MoeStateListener {
    fun onState(state: MoeState)
    fun onStatus(connected: Boolean, message: String)
    fun onError(operation: String, message: String) {}
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
}

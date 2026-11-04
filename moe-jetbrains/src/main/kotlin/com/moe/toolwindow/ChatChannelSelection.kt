package com.moe.toolwindow

import com.moe.model.ChatChannel

/**
 * Which chat channel the panel shows after the channel list changes.
 *
 * One rule serves both the initial selection and the fallback when the selected channel was
 * deleted (CHANNEL_DELETED, or a refresh that no longer lists it). It matches VS Code's VSC-6
 * fallback in moe-vscode/media/chat.js.
 *
 * "First" means the daemon's list order (StateManager sorts snapshot channels by createdAt and
 * persistence seeds #general first), NOT the combo's name order.
 *
 * The rule is total: an empty list or an unknown or blank id is ordinary input that yields the
 * fallback or null, never an exception.
 */
object ChatChannelSelection {
    const val GENERAL_TYPE = "general"

    fun choose(channels: List<ChatChannel>, previousId: String?): ChatChannel? {
        if (previousId != null) {
            channels.firstOrNull { it.id == previousId }?.let { return it }
        }
        return channels.firstOrNull { it.type == GENERAL_TYPE } ?: channels.firstOrNull()
    }
}

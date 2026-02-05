package com.moe.util

import com.intellij.DynamicBundle
import org.jetbrains.annotations.NonNls
import org.jetbrains.annotations.PropertyKey

@NonNls
private const val BUNDLE = "messages.MoeBundle"

/**
 * Resource bundle accessor for Moe plugin localization.
 * Usage: MoeBundle.message("moe.panel.title")
 * Usage with params: MoeBundle.message("moe.dialog.taskDetail", task.title)
 */
object MoeBundle {
    private val INSTANCE = DynamicBundle(MoeBundle::class.java, BUNDLE)

    /**
     * Get a localized message from the bundle.
     * @param key The property key (e.g., "moe.panel.title")
     * @param params Optional parameters for message formatting
     */
    @JvmStatic
    fun message(@PropertyKey(resourceBundle = BUNDLE) key: String, vararg params: Any): String {
        return INSTANCE.getMessage(key, *params)
    }
}

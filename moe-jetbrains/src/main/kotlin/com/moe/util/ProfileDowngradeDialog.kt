package com.moe.util

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ui.Messages
import java.io.File

/** A non-blocking, safe-default human decision; the policy applies an allowed downgrade only after restart. */
object ProfileDowngradeDialog : DowngradeConfirmer {
    private val log = Logger.getInstance(ProfileDowngradeDialog::class.java)
    private val OPTIONS = arrayOf("Keep Protected", "Allow Downgrade")
    private const val KEEP = 0
    private const val ALLOW = 1

    internal fun confirmed(choice: Int): Boolean = choice == ALLOW

    override fun ask(basePath: String, answer: (Boolean) -> Unit) = failClosed(answer) {
        val app = ApplicationManager.getApplication()
        if (app == null || app.isUnitTestMode || app.isHeadlessEnvironment) {
            answer(false)
            return@failClosed
        }
        app.invokeLater {
            failClosed(answer) {
                val name = File(basePath).name
                val message = "$name now declares the legacy execution profile, but it was confirmed protected. " +
                    "Moe keeps it protected until you allow the downgrade. " +
                    "An allowed downgrade takes effect after you restart the IDE."
                val choice = Messages.showDialog(message, "Moe: Execution Profile Downgrade", OPTIONS, KEEP, Messages.getWarningIcon())
                app.executeOnPooledThread { answer(confirmed(choice)) }
            }
        }
    }

    private inline fun failClosed(answer: (Boolean) -> Unit, action: () -> Unit) {
        try {
            action()
        } catch (ex: Exception) {
            log.warn("Moe keeps the protected profile: downgrade dialog failed (${ex.javaClass.simpleName})")
            answer(false)
        }
    }
}

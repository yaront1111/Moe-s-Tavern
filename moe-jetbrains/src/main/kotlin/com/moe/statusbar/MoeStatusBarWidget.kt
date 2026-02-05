package com.moe.statusbar

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.Consumer
import com.moe.model.MoeState
import com.moe.model.ActivityEvent
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import java.awt.event.MouseEvent
import javax.swing.Icon

class MoeStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    companion object {
        const val ID = "MoeStatusBarWidget"
    }

    private var statusBar: StatusBar? = null
    private var connected = false
    private var connectionStateKnown = false
    private var awaitingCount = 0
    private var workingCount = 0

    private val listener = object : MoeStateListener {
        override fun onState(state: MoeState) {
            awaitingCount = state.tasks.count { it.status == "AWAITING_APPROVAL" }
            workingCount = state.tasks.count { it.status == "WORKING" }
            // Receiving state means we're connected
            if (!connectionStateKnown) {
                connectionStateKnown = true
                connected = true
            }
            updateWidget()
        }

        override fun onStatus(connected: Boolean, message: String) {
            this@MoeStatusBarWidget.connected = connected
            connectionStateKnown = true
            updateWidget()
        }

        override fun onError(operation: String, message: String) {}
        override fun onActivityLog(events: List<ActivityEvent>) {}
    }

    override fun ID(): String = ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val service = project.getService(MoeProjectService::class.java)
        service?.addListener(listener)
    }

    override fun dispose() {
        val service = project.getService(MoeProjectService::class.java)
        service?.removeListener(listener)
        statusBar = null
    }

    override fun getText(): String {
        return when {
            !connectionStateKnown -> "◐ Moe: connecting..."
            connected -> "● Moe: $awaitingCount awaiting | $workingCount working"
            else -> "○ Moe: disconnected"
        }
    }

    override fun getAlignment(): Float = 0f

    override fun getTooltipText(): String {
        return when {
            !connectionStateKnown -> "Moe: Connecting to daemon... Click to open board."
            connected -> "Moe: $awaitingCount tasks awaiting approval, $workingCount tasks in progress. Click to open board."
            else -> "Moe: Not connected to daemon. Click to open board."
        }
    }

    override fun getClickConsumer(): Consumer<MouseEvent> {
        return Consumer {
            val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("Moe")
            toolWindow?.show()
        }
    }

    private fun updateWidget() {
        statusBar?.updateWidget(ID)
    }
}

package com.moe.toolwindow

import com.moe.model.Task
import com.moe.model.Worker
import com.moe.toolwindow.board.BoardStyles
import com.moe.util.MoeBundle
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import javax.swing.BorderFactory

class WorkerPanel : JBPanel<WorkerPanel>(FlowLayout(FlowLayout.LEFT, 8, 4)) {
    init {
        border = JBUI.Borders.empty(4, 12)
        isOpaque = false
    }

    fun updateWorkers(workers: List<Worker>, tasks: Map<String, Task>) {
        removeAll()

        if (workers.isEmpty()) {
            add(JBLabel(MoeBundle.message("moe.message.noActiveWorkers")).apply {
                foreground = JBColor.GRAY
            })
        } else {
            for (worker in workers) {
                add(createWorkerCard(worker, tasks))
            }
        }

        revalidate()
        repaint()
    }

    private fun createWorkerCard(worker: Worker, tasks: Map<String, Task>): JBPanel<JBPanel<*>> {
        val card = JBPanel<JBPanel<*>>(BorderLayout()).apply {
            preferredSize = Dimension(200, 60)
            border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(getStatusBorderColor(worker.status)),
                JBUI.Borders.empty(6, 8)
            )
            background = BoardStyles.cardBackground
            isOpaque = true
        }

        val header = JBPanel<JBPanel<*>>(BorderLayout()).apply {
            isOpaque = false
        }

        val typeLabel = JBLabel(worker.type).apply {
            font = font.deriveFont(Font.BOLD)
            foreground = BoardStyles.textPrimary
        }
        header.add(typeLabel, BorderLayout.WEST)

        val statusLabel = JBLabel(worker.status).apply {
            foreground = getStatusTextColor(worker.status)
            font = font.deriveFont(font.size - 1f)
        }
        header.add(statusLabel, BorderLayout.EAST)

        card.add(header, BorderLayout.NORTH)

        val currentTask = worker.currentTaskId?.let { tasks[it] }
        val taskTitle = currentTask?.title ?: worker.lastError ?: MoeBundle.message("moe.message.idle")
        val taskLabel = JBLabel(truncate(taskTitle, 28)).apply {
            foreground = if (worker.status == "BLOCKED") {
                JBColor(Color(220, 53, 69), Color(255, 80, 80))
            } else {
                JBColor.GRAY
            }
            font = font.deriveFont(font.size - 1f)
        }
        card.add(taskLabel, BorderLayout.CENTER)

        return card
    }

    private fun getStatusBorderColor(status: String): Color {
        return when (status) {
            "BLOCKED" -> JBColor(Color(220, 53, 69), Color(255, 80, 80))
            "CODING", "PLANNING" -> JBColor(Color(0, 123, 255), Color(100, 149, 237))
            "AWAITING_APPROVAL" -> JBColor(Color(255, 193, 7), Color(255, 215, 0))
            else -> JBColor.border()
        }
    }

    private fun getStatusTextColor(status: String): Color {
        return when (status) {
            "BLOCKED" -> JBColor(Color(220, 53, 69), Color(255, 80, 80))
            "CODING", "PLANNING" -> JBColor(Color(0, 123, 255), Color(100, 149, 237))
            "AWAITING_APPROVAL" -> JBColor(Color(255, 193, 7), Color(255, 215, 0))
            "IDLE" -> JBColor.GRAY
            else -> BoardStyles.textPrimary
        }
    }

    private fun truncate(text: String, maxLen: Int): String {
        return if (text.length > maxLen) text.take(maxLen - 3) + "..." else text
    }
}

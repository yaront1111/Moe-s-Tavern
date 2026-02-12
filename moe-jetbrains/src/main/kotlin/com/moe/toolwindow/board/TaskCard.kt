package com.moe.toolwindow.board

import com.moe.model.Task
import com.moe.util.MoeBundle
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.datatransfer.StringSelection
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.Font
import java.awt.Component
import java.awt.Container
import javax.swing.JMenuItem
import javax.swing.JPopupMenu
import javax.swing.TransferHandler
import javax.swing.SwingUtilities

class TaskCard(
    private val task: Task,
    private val epicTitle: String?,
    private val columnStatus: String,
    private val onOpen: (Task) -> Unit,
    private val onDelete: (Task) -> Unit,
    private val onNext: ((Task) -> Unit)? = null,
    private val onPrevious: ((Task) -> Unit)? = null
) : RoundedPanel(10, BoardStyles.borderColor, BorderLayout()) {

    init {
        border = JBUI.Borders.empty(6, 8)
        background = BoardStyles.cardBackground

        val stripe = JBPanel<JBPanel<*>>().apply {
            background = BoardStyles.statusColor(task.status)
            isOpaque = true
            preferredSize = Dimension(4, 0)
        }

        val title = JBLabel(task.title).apply {
            foreground = BoardStyles.textPrimary
            font = font.deriveFont(Font.BOLD)
        }

        val descriptionText = task.description.trim()
        val description = if (descriptionText.isNotEmpty()) {
            JBLabel(truncate(descriptionText, 120)).apply {
                foreground = BoardStyles.textSecondary
                font = JBUI.Fonts.smallFont()
            }
        } else null

        val meta = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
            isOpaque = false
        }

        if (!epicTitle.isNullOrBlank()) {
            meta.add(chip(epicTitle))
        }

        // Priority chip (skip MEDIUM to reduce noise)
        if (task.priority != "MEDIUM") {
            val priorityColor = when (task.priority) {
                "CRITICAL" -> JBColor(java.awt.Color(220, 53, 69), java.awt.Color(255, 80, 80))
                "HIGH" -> JBColor(java.awt.Color(255, 152, 0), java.awt.Color(255, 183, 77))
                "LOW" -> JBColor(java.awt.Color(158, 158, 158), java.awt.Color(120, 120, 120))
                else -> BoardStyles.textSecondary
            }
            val priorityLabel = task.priority.lowercase().replaceFirstChar { it.uppercase() }
            meta.add(JBLabel(priorityLabel).apply {
                isOpaque = true
                border = JBUI.Borders.empty(2, 6)
                font = JBUI.Fonts.smallFont()
                foreground = java.awt.Color.WHITE
                background = priorityColor
            })
        }

        if (task.status != columnStatus) {
            meta.add(chip(humanizeStatus(task.status), subtle = true))
        }

        meta.add(chip(task.id.takeLast(4).uppercase(), subtle = true))

        val content = JBPanel<JBPanel<*>>(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(2, 8, 2, 6)
        }

        val body = JBPanel<JBPanel<*>>(com.intellij.ui.components.panels.VerticalLayout(4)).apply {
            isOpaque = false
        }
        body.add(title)
        if (description != null) {
            body.add(description)
        }
        body.add(meta)

        content.add(body, BorderLayout.CENTER)

        val arrows = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.RIGHT, 2, 0)).apply {
            isOpaque = false
        }
        if (onPrevious != null) {
            arrows.add(JBLabel("\u25C0").apply {
                foreground = BoardStyles.textSecondary
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                font = JBUI.Fonts.smallFont()
                toolTipText = MoeBundle.message("moe.button.previous")
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        e.consume()
                        safeCallback("move task back") { onPrevious.invoke(task) }
                    }
                })
            })
        }
        if (onNext != null) {
            arrows.add(JBLabel("\u25B6").apply {
                foreground = BoardStyles.textSecondary
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                font = JBUI.Fonts.smallFont()
                toolTipText = MoeBundle.message("moe.button.next")
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        e.consume()
                        safeCallback("move task forward") { onNext.invoke(task) }
                    }
                })
            })
        }
        if (onPrevious != null || onNext != null) {
            content.add(arrows, BorderLayout.EAST)
        }

        add(stripe, BorderLayout.WEST)
        add(content, BorderLayout.CENTER)

        transferHandler = TaskTransferHandler(task.id)
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)

        val dragAdapter = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e) && e.clickCount == 1) {
                    safeCallback("open task") { onOpen(task) }
                } else if (SwingUtilities.isRightMouseButton(e)) {
                    showContextMenu(e)
                }
            }

            override fun mouseDragged(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e)) {
                    safeCallback("drag task") {
                        transferHandler.exportAsDrag(this@TaskCard, e, TransferHandler.MOVE)
                    }
                }
            }
        }
        installDragHandlers(this, dragAdapter)

        addMouseListener(object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                background = BoardStyles.cardHoverBackground
                repaint()
            }

            override fun mouseExited(e: MouseEvent) {
                background = BoardStyles.cardBackground
                repaint()
            }
        })
    }

    private fun showContextMenu(e: MouseEvent) {
        val menu = JPopupMenu()

        val openItem = JMenuItem(MoeBundle.message("moe.menu.open"))
        openItem.addActionListener { safeCallback("open task") { onOpen(task) } }
        menu.add(openItem)

        val askItem = JMenuItem(MoeBundle.message("moe.button.askQuestion"))
        askItem.addActionListener { safeCallback("ask question") { onOpen(task) } }
        menu.add(askItem)

        menu.addSeparator()

        val deleteItem = JMenuItem(MoeBundle.message("moe.menu.delete"))
        deleteItem.addActionListener { safeCallback("delete task") { onDelete(task) } }
        menu.add(deleteItem)

        menu.show(e.component, e.x, e.y)
    }

    private fun chip(text: String, subtle: Boolean = false): JBLabel {
        val label = JBLabel(text)
        label.isOpaque = true
        label.border = JBUI.Borders.empty(2, 6)
        label.font = JBUI.Fonts.smallFont()
        if (subtle) {
            label.background = BoardStyles.statusTint(task.status)
            label.foreground = BoardStyles.textPrimary
        } else {
            label.background = BoardStyles.columnHeaderBackground
            label.foreground = BoardStyles.textSecondary
        }
        return label
    }

    private fun truncate(text: String, max: Int): String {
        return if (text.length <= max) text else text.take(max - 1).trimEnd() + "…"
    }

    private fun humanizeStatus(status: String): String {
        return status.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }
    }

    /**
     * Wraps a callback in error handling to prevent UI crashes.
     * Shows a notification balloon if an error occurs.
     */
    private fun safeCallback(operation: String, callback: () -> Unit) {
        try {
            callback()
        } catch (e: Exception) {
            showErrorNotification("Failed to $operation: ${e.message ?: "Unknown error"}")
        }
    }

    private fun showErrorNotification(message: String) {
        try {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Moe Notifications")
                .createNotification(message, NotificationType.ERROR)
                .notify(null)
        } catch (e: Exception) {
            // Fallback: log to stderr if notification fails
            System.err.println("Moe TaskCard error: $message")
        }
    }

    private fun installDragHandlers(component: Component, adapter: MouseAdapter) {
        // Use iterative approach with depth limit to prevent stack overflow on deep nesting
        val maxDepth = 20
        val stack = ArrayDeque<Pair<Component, Int>>()
        stack.addLast(component to 0)

        while (stack.isNotEmpty()) {
            val (current, depth) = stack.removeLast()
            if (depth > maxDepth) continue

            current.addMouseListener(adapter)
            current.addMouseMotionListener(adapter)
            if (current is javax.swing.JComponent) {
                current.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            }

            if (current is Container) {
                current.components.forEach { child ->
                    stack.addLast(child to depth + 1)
                }
            }
        }
    }

    private class TaskTransferHandler(private val taskId: String) : TransferHandler() {
        override fun createTransferable(c: javax.swing.JComponent?): java.awt.datatransfer.Transferable {
            return StringSelection("task:$taskId")
        }

        override fun getSourceActions(c: javax.swing.JComponent?): Int = MOVE
    }
}

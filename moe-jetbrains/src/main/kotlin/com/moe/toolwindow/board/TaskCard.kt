package com.moe.toolwindow.board

import com.moe.model.Task
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
    private val onDelete: (Task) -> Unit
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

        add(stripe, BorderLayout.WEST)
        add(content, BorderLayout.CENTER)

        transferHandler = TaskTransferHandler(task.id)
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)

        val dragAdapter = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e) && e.clickCount == 1) {
                    onOpen(task)
                } else if (SwingUtilities.isRightMouseButton(e)) {
                    showContextMenu(e)
                }
            }

            override fun mouseDragged(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e)) {
                    transferHandler.exportAsDrag(this@TaskCard, e, TransferHandler.MOVE)
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

        val openItem = JMenuItem("Open")
        openItem.addActionListener { onOpen(task) }
        menu.add(openItem)

        menu.addSeparator()

        val deleteItem = JMenuItem("Delete")
        deleteItem.addActionListener { onDelete(task) }
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

    private fun installDragHandlers(component: Component, adapter: MouseAdapter) {
        component.addMouseListener(adapter)
        component.addMouseMotionListener(adapter)
        if (component is javax.swing.JComponent) {
            component.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }
        if (component is Container) {
            component.components.forEach { child ->
                installDragHandlers(child, adapter)
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

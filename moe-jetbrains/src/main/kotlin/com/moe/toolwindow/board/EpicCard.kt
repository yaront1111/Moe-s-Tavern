package com.moe.toolwindow.board

import com.moe.model.Epic
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.Component
import java.awt.Container
import javax.swing.TransferHandler
import javax.swing.SwingUtilities

class EpicCard(
    private val epic: Epic,
    private val taskCount: Int,
    private val onOpen: (Epic) -> Unit
) : RoundedPanel(12, BoardStyles.borderColor, BorderLayout()) {

    init {
        border = JBUI.Borders.empty(8, 10)
        background = BoardStyles.cardBackground

        val title = JBLabel(epic.title).apply {
            foreground = BoardStyles.textPrimary
            font = font.deriveFont(Font.BOLD)
        }

        val descriptionText = epic.description.trim()
        val description = if (descriptionText.isNotEmpty()) {
            JBLabel(truncate(descriptionText, 140)).apply {
                foreground = BoardStyles.textSecondary
                font = JBUI.Fonts.smallFont()
            }
        } else null

        val meta = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
            isOpaque = false
        }
        meta.add(chip(humanizeStatus(epic.status), accent = true))
        meta.add(chip("$taskCount tasks", subtle = true))

        val body = JBPanel<JBPanel<*>>(com.intellij.ui.components.panels.VerticalLayout(4)).apply {
            isOpaque = false
        }
        body.add(title)
        if (description != null) body.add(description)
        body.add(meta)

        add(body, BorderLayout.CENTER)

        transferHandler = EpicTransferHandler(epic.id)
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)

        val dragAdapter = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    onOpen(epic)
                }
            }

            override fun mouseDragged(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e)) {
                    transferHandler.exportAsDrag(this@EpicCard, e, TransferHandler.MOVE)
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

    private fun chip(text: String, subtle: Boolean = false, accent: Boolean = false): JBLabel {
        val label = JBLabel(text)
        label.isOpaque = true
        label.border = JBUI.Borders.empty(2, 6)
        label.font = JBUI.Fonts.smallFont()
        label.background = if (accent) BoardStyles.statusTint(epic.status) else if (subtle) BoardStyles.columnHeaderBackground else BoardStyles.cardBackground
        label.foreground = if (accent) BoardStyles.textPrimary else BoardStyles.textSecondary
        return label
    }

    private fun truncate(text: String, max: Int): String {
        return if (text.length <= max) text else text.take(max - 1).trimEnd() + "…"
    }

    private fun humanizeStatus(status: String): String {
        return status.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }
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

    private class EpicTransferHandler(private val epicId: String) : TransferHandler() {
        override fun createTransferable(c: javax.swing.JComponent?): java.awt.datatransfer.Transferable {
            return StringSelection("epic:$epicId")
        }

        override fun getSourceActions(c: javax.swing.JComponent?): Int = MOVE
    }
}

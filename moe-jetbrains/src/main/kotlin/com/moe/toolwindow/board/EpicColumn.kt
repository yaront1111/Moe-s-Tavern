package com.moe.toolwindow.board

import com.moe.model.Epic
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.datatransfer.DataFlavor
import javax.swing.JPanel
import javax.swing.TransferHandler
import javax.swing.TransferHandler.TransferSupport
import com.intellij.ui.components.panels.VerticalLayout

class EpicColumn(
    private val title: String,
    private val status: String,
    private val epics: List<Epic>,
    private val taskCounts: Map<String, Int>,
    private val onDrop: (epicId: String, status: String, order: Double) -> Unit,
    private val onOpen: (Epic) -> Unit
) : JBPanel<EpicColumn>(BorderLayout()) {

    init {
        border = JBUI.Borders.empty(6)
        isOpaque = false

        val dropHandler = object : TransferHandler() {
            override fun canImport(support: TransferSupport): Boolean {
                if (!support.isDataFlavorSupported(DataFlavor.stringFlavor)) return false
                val raw = support.transferable.getTransferData(DataFlavor.stringFlavor) as? String ?: return false
                return parseEpicId(raw) != null
            }

            override fun importData(support: TransferSupport): Boolean {
                if (!canImport(support)) return false
                val raw = support.transferable.getTransferData(DataFlavor.stringFlavor) as String
                val epicId = parseEpicId(raw) ?: return false
                val order = if (epics.isEmpty()) 1.0 else (epics.maxOf { it.order } + 1.0)
                onDrop(epicId, status, order)
                return true
            }
        }

        transferHandler = dropHandler

        val container = RoundedPanel(12, BoardStyles.borderColor, BorderLayout()).apply {
            background = BoardStyles.columnBackground
        }

        val header = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(8, 10, 6, 10)
        }

        val left = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply { isOpaque = false }
        left.add(StatusDot(BoardStyles.statusColor(status)))
        val titleLabel = JBLabel(title).apply {
            foreground = BoardStyles.textPrimary
            font = JBUI.Fonts.label().deriveFont(java.awt.Font.BOLD)
        }
        left.add(titleLabel)

        val countLabel = JBLabel(epics.size.toString()).apply {
            isOpaque = true
            background = BoardStyles.statusTint(status)
            foreground = BoardStyles.textPrimary
            border = JBUI.Borders.empty(2, 6)
            font = JBUI.Fonts.smallFont()
        }

        header.add(left, BorderLayout.WEST)
        header.add(countLabel, BorderLayout.EAST)

        val listPanel = JPanel(VerticalLayout(8))
        listPanel.isOpaque = false
        listPanel.border = JBUI.Borders.empty(2, 8, 8, 8)
        listPanel.transferHandler = dropHandler

        for (epic in epics.sortedBy { it.order }) {
            val count = taskCounts[epic.id] ?: 0
            listPanel.add(EpicCard(epic, count, onOpen))
        }

        val body = JPanel(BorderLayout())
        body.isOpaque = false
        body.add(listPanel, BorderLayout.NORTH)

        container.add(header, BorderLayout.NORTH)
        container.add(body, BorderLayout.CENTER)
        container.transferHandler = dropHandler

        add(container, BorderLayout.CENTER)
    }

    private fun parseEpicId(raw: String): String? {
        return when {
            raw.startsWith("epic:") -> raw.removePrefix("epic:")
            raw.startsWith("epic-") -> raw
            else -> null
        }
    }
}

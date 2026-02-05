package com.moe.toolwindow.board

import com.moe.model.Task
import com.moe.model.Epic
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Container
import java.awt.Cursor
import java.awt.FlowLayout
import java.awt.Font
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JPanel
import javax.swing.TransferHandler
import javax.swing.TransferHandler.TransferSupport
import com.intellij.ui.components.panels.VerticalLayout
import javax.swing.SwingUtilities

class TaskColumn(
    private val title: String,
    private val status: String,
    private val tasks: List<Task>,
    private val epicMeta: Map<String, Epic>,
    private val collapsedEpics: Set<String>,
    private val onToggleEpic: (String) -> Unit,
    private val onOpenEpic: (Epic) -> Unit,
    private val onDrop: (taskId: String, status: String, order: Double) -> Unit,
    private val onEpicDrop: (epicId: String, status: String) -> Unit,
    private val onOpen: (Task) -> Unit,
    private val onDelete: (Task) -> Unit,
    private val onCreateTask: (() -> Unit)? = null
) : JBPanel<TaskColumn>(BorderLayout()) {

    init {
        border = JBUI.Borders.empty(6)
        isOpaque = false

        val dropHandler = object : TransferHandler() {
            override fun canImport(support: TransferSupport): Boolean {
                if (!support.isDataFlavorSupported(DataFlavor.stringFlavor)) return false
                val raw = support.transferable.getTransferData(DataFlavor.stringFlavor) as? String ?: return false
                return parseTaskId(raw) != null || parseEpicId(raw) != null
            }

            override fun importData(support: TransferSupport): Boolean {
                if (!canImport(support)) return false
                val raw = support.transferable.getTransferData(DataFlavor.stringFlavor) as String
                val epicId = parseEpicId(raw)
                if (epicId != null) {
                    onEpicDrop(epicId, status)
                    return true
                }
                val taskId = parseTaskId(raw) ?: return false
                val order = if (tasks.isEmpty()) 1.0 else (tasks.maxOf { it.order } + 1.0)
                val existing = tasks.find { it.id == taskId }
                val nextStatus = if (status == "PLANNING" && existing?.status == "AWAITING_APPROVAL") {
                    "AWAITING_APPROVAL"
                } else {
                    status
                }
                onDrop(taskId, nextStatus, order)
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

        val left = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
            isOpaque = false
        }
        left.add(StatusDot(BoardStyles.statusColor(status)))

        val titleLabel = JBLabel(title).apply {
            foreground = BoardStyles.textPrimary
            font = JBUI.Fonts.label().deriveFont(java.awt.Font.BOLD)
        }
        left.add(titleLabel)

        val countLabel = JBLabel(tasks.size.toString()).apply {
            isOpaque = true
            background = BoardStyles.statusTint(status)
            foreground = BoardStyles.textPrimary
            border = JBUI.Borders.empty(2, 6)
            font = JBUI.Fonts.smallFont()
        }

        val right = JPanel(FlowLayout(FlowLayout.RIGHT, 6, 0)).apply {
            isOpaque = false
        }
        right.add(countLabel)

        if (onCreateTask != null) {
            val createBtn = JBLabel("+").apply {
                foreground = BoardStyles.textPrimary
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                font = JBUI.Fonts.label().deriveFont(Font.BOLD, 16f)
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        onCreateTask?.invoke()
                    }
                })
            }
            right.add(createBtn)
        }

        header.add(left, BorderLayout.WEST)
        header.add(right, BorderLayout.EAST)

        val listPanel = JPanel(VerticalLayout(8))
        listPanel.isOpaque = false
        listPanel.border = JBUI.Borders.empty(2, 8, 8, 8)
        listPanel.transferHandler = dropHandler

        val grouped = tasks.groupBy { it.epicId }
        val sortedEpicIds = grouped.keys.sortedWith(
            compareBy({ epicMeta[it]?.order ?: Double.MAX_VALUE }, { epicMeta[it]?.title ?: "No Epic" })
        )

        for (epicId in sortedEpicIds) {
            val epic = epicMeta[epicId]
            val epicTitle = epic?.title ?: "No Epic"
            val epicStatus = epic?.status ?: "PLANNED"
            val isCollapsed = epicId != null && collapsedEpics.contains(epicId)
            listPanel.add(epicHeader(epic, epicId, epicTitle, epicStatus, grouped[epicId]?.size ?: 0, isCollapsed))
            val epicTasks = grouped[epicId].orEmpty().sortedBy { it.order }
            if (!isCollapsed) {
                for (task in epicTasks) {
                    listPanel.add(TaskCard(task, epicTitle, status, onOpen, onDelete))
                }
            }
        }

        val body = JPanel(BorderLayout())
        body.isOpaque = false
        body.add(listPanel, BorderLayout.NORTH)

        container.add(header, BorderLayout.NORTH)
        container.add(body, BorderLayout.CENTER)
        container.transferHandler = dropHandler

        add(container, BorderLayout.CENTER)
    }

    private fun parseTaskId(raw: String): String? {
        return when {
            raw.startsWith("task:") -> raw.removePrefix("task:")
            raw.startsWith("task-") -> raw
            else -> null
        }
    }

    private fun parseEpicId(raw: String): String? {
        return when {
            raw.startsWith("epic:") -> raw.removePrefix("epic:")
            raw.startsWith("epic-") -> raw
            else -> null
        }
    }

    private fun epicHeader(
        epic: Epic?,
        epicId: String?,
        title: String,
        status: String,
        count: Int,
        collapsed: Boolean
    ): JPanel {
        val panel = RoundedPanel(8, BoardStyles.borderColor, BorderLayout())
        panel.background = BoardStyles.columnHeaderBackground
        panel.border = JBUI.Borders.empty(6, 6, 6, 6)

        val collapseLabel = JBLabel(if (collapsed) ">" else "v").apply {
            foreground = BoardStyles.textSecondary
            font = JBUI.Fonts.smallFont().deriveFont(Font.BOLD)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        val label = JBLabel(title).apply {
            foreground = BoardStyles.textSecondary
            font = JBUI.Fonts.smallFont().deriveFont(java.awt.Font.BOLD)
        }

        val left = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply { isOpaque = false }
        if (epicId != null) {
            left.add(collapseLabel)
        }
        left.add(StatusDot(BoardStyles.statusColor(status)))
        left.add(label)

        val badge = JBLabel(count.toString()).apply {
            isOpaque = true
            background = BoardStyles.cardBackground
            foreground = BoardStyles.textSecondary
            border = JBUI.Borders.empty(1, 6)
            font = JBUI.Fonts.smallFont()
        }
        val statusChip = JBLabel(humanizeStatus(status)).apply {
            isOpaque = true
            background = BoardStyles.statusTint(status)
            foreground = BoardStyles.textPrimary
            border = JBUI.Borders.empty(1, 6)
            font = JBUI.Fonts.smallFont()
        }
        val right = JPanel(FlowLayout(FlowLayout.RIGHT, 6, 0)).apply { isOpaque = false }
        right.add(statusChip)
        right.add(badge)

        panel.add(left, BorderLayout.WEST)
        panel.add(right, BorderLayout.EAST)

        if (epicId != null) {
            collapseLabel.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    onToggleEpic(epicId)
                }
            })
        }

        if (epic != null) {
            panel.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount == 2) {
                        onOpenEpic(epic)
                    }
                }
            })
        }

        if (epicId != null) {
            panel.transferHandler = EpicTransferHandler(epicId)
            val dragAdapter = object : MouseAdapter() {
                override fun mouseDragged(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) {
                        panel.transferHandler.exportAsDrag(panel, e, TransferHandler.MOVE)
                    }
                }
            }
            installDragHandlers(panel, dragAdapter)
        }

        return panel
    }

    /**
     * Installs drag handlers on a component and all its children using an iterative approach.
     * Uses a stack to avoid potential stack overflow on deeply nested components.
     * Limits traversal depth to prevent issues with circular references.
     */
    private fun installDragHandlers(component: Component, adapter: MouseAdapter) {
        val maxDepth = 20
        val stack = ArrayDeque<Pair<Component, Int>>()
        stack.addLast(component to 0)

        while (stack.isNotEmpty()) {
            val (current, depth) = stack.removeLast()

            current.addMouseListener(adapter)
            current.addMouseMotionListener(adapter)
            if (current is javax.swing.JComponent) {
                current.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            }

            // Only traverse children if within depth limit
            if (depth < maxDepth && current is Container) {
                for (child in current.components) {
                    stack.addLast(child to depth + 1)
                }
            }
        }
    }

    private fun humanizeStatus(status: String): String {
        return status.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }
    }

    private class EpicTransferHandler(private val epicId: String) : TransferHandler() {
        override fun createTransferable(c: javax.swing.JComponent?): java.awt.datatransfer.Transferable {
            return StringSelection("epic:$epicId")
        }

        override fun getSourceActions(c: javax.swing.JComponent?): Int = MOVE
    }
}

package com.moe.toolwindow

import com.moe.model.MoeState
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.toolwindow.board.TaskColumn
import com.moe.toolwindow.board.BoardStyles
import com.moe.util.MoeProjectInitializer
import com.moe.util.MoeProjectRegistry
import com.moe.util.TerminalAgentLauncher
import com.intellij.openapi.project.Project
import com.intellij.openapi.components.service
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.Messages
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.ide.impl.ProjectUtil
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Cursor
import java.io.File
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.JPanel
import javax.swing.JTabbedPane
import javax.swing.SwingUtilities

class MoeToolWindowPanel(private val project: Project) : JBPanel<MoeToolWindowPanel>(BorderLayout()) {
    private val service = project.service<MoeProjectService>()
    private val statusLabel = JBLabel("Disconnected")
    private val contentPanel = JBPanel<JBPanel<*>>(BorderLayout())
    private val collapsedEpics = mutableSetOf<String>()
    private var lastState: MoeState? = null
    private val projectSelector = ComboBox<ProjectItem>()
    private var updatingSelector = false
    private val epicFilter = ComboBox<EpicFilterItem>()
    private var selectedEpicId: String? = null
    private var updatingEpicFilter = false

    init {
        val header = JPanel(BorderLayout())
        header.border = com.intellij.util.ui.JBUI.Borders.empty(8, 12)
        header.isOpaque = false

        val title = JBLabel("Moe Board").apply {
            font = com.intellij.util.ui.JBUI.Fonts.label().deriveFont(java.awt.Font.BOLD, 15f)
            foreground = BoardStyles.textPrimary
        }

        styleStatusLabel(false, "Disconnected")

        val right = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0)).apply {
            isOpaque = false
        }
        right.add(JBLabel("Epic:"))
        epicFilter.preferredSize = Dimension(180, epicFilter.preferredSize.height)
        right.add(epicFilter)

        right.add(Box.createHorizontalStrut(8))
        right.add(JBLabel("Project:"))
        projectSelector.preferredSize = Dimension(280, projectSelector.preferredSize.height)
        right.add(projectSelector)

        val addEpicButton = JBLabel("+ Epic").apply {
            isOpaque = true
            background = BoardStyles.columnHeaderBackground
            foreground = BoardStyles.textPrimary
            border = com.intellij.util.ui.JBUI.Borders.empty(4, 8)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    CreateEpicDialog(project, service).show()
                }
            })
        }
        right.add(addEpicButton)

        val agentsButton = JBLabel("Start Agents").apply {
            isOpaque = true
            background = BoardStyles.columnHeaderBackground
            foreground = BoardStyles.textPrimary
            border = com.intellij.util.ui.JBUI.Borders.empty(4, 8)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    TerminalAgentLauncher.startAgents(project)
                }
            })
        }
        right.add(agentsButton)

        right.add(statusLabel)

        header.add(title, BorderLayout.WEST)
        header.add(right, BorderLayout.EAST)

        add(header, BorderLayout.NORTH)
        background = BoardStyles.boardBackground
        contentPanel.background = BoardStyles.boardBackground

        val scroll = JBScrollPane(contentPanel).apply {
            border = com.intellij.util.ui.JBUI.Borders.empty()
            viewport.background = BoardStyles.boardBackground
        }

        val tabbedPane = JTabbedPane().apply {
            addTab("Board", scroll)
            addTab("Proposals", ProposalPanel(project))
            addTab("Activity Log", ActivityLogPanel(project))
        }
        add(tabbedPane, BorderLayout.CENTER)

        service.addListener(object : MoeStateListener {
            override fun onState(state: MoeState) {
                updateBoard(state)
            }

            override fun onStatus(connected: Boolean, message: String) {
                styleStatusLabel(connected, message)
            }

            override fun onError(operation: String, message: String) {
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("Moe Notifications")
                    .createNotification("Moe Error", "$operation: $message", NotificationType.ERROR)
                    .notify(project)
            }
        })

        service.connect()

        reloadProjectSelector()
        projectSelector.addActionListener {
            if (updatingSelector) return@addActionListener
            val item = projectSelector.selectedItem as? ProjectItem ?: return@addActionListener
            if (item.isBrowse) {
                chooseAndOpenProject()
            } else {
                openProject(item.path)
            }
        }

        epicFilter.addActionListener {
            if (updatingEpicFilter) return@addActionListener
            val item = epicFilter.selectedItem as? EpicFilterItem ?: return@addActionListener
            selectedEpicId = item.epicId
            lastState?.let { updateBoard(it) }
        }
    }

    private fun styleStatusLabel(connected: Boolean, message: String) {
        statusLabel.text = if (connected) "Connected" else message
        statusLabel.isOpaque = true
        statusLabel.border = com.intellij.util.ui.JBUI.Borders.empty(2, 8)
        if (connected) {
            statusLabel.background = BoardStyles.connectedBackground
            statusLabel.foreground = BoardStyles.connectedText
        } else {
            statusLabel.background = BoardStyles.disconnectedBackground
            statusLabel.foreground = BoardStyles.disconnectedText
        }
    }

    private fun updateBoard(state: MoeState) {
        lastState = state
        SwingUtilities.invokeLater {
            // Update epic filter dropdown
            updateEpicFilter(state.epics)

            // Filter tasks by selected epic
            val allTasks = state.tasks.sortedBy { it.order }
            val tasks = if (selectedEpicId != null) {
                allTasks.filter { it.epicId == selectedEpicId }
            } else {
                allTasks
            }
            val epicMeta = state.epics.associateBy { it.id }

            fun displayStatus(taskStatus: String): String {
                return if (taskStatus == "AWAITING_APPROVAL") "PLANNING" else taskStatus
            }

            fun mapEpicStatus(taskStatus: String): String {
                return when (taskStatus) {
                    "BACKLOG", "PLANNING" -> "PLANNED"
                    "WORKING" -> "ACTIVE"
                    "REVIEW", "DONE" -> "COMPLETED"
                    else -> "PLANNED"
                }
            }

            fun toggleEpic(epicId: String) {
                if (collapsedEpics.contains(epicId)) {
                    collapsedEpics.remove(epicId)
                } else {
                    collapsedEpics.add(epicId)
                }
                lastState?.let { updateBoard(it) }
            }

            fun buildTaskColumn(board: JBPanel<JBPanel<*>>, title: String, status: String, isBacklog: Boolean = false) {
                val columnTasks = tasks.filter { displayStatus(it.status) == status }
                val column = TaskColumn(
                    title = title,
                    status = status,
                    tasks = columnTasks,
                    epicMeta = epicMeta,
                    collapsedEpics = collapsedEpics,
                    onToggleEpic = { epicId -> toggleEpic(epicId) },
                    onOpenEpic = { epic ->
                        EpicDetailDialog(project, epic, service).show()
                    },
                    onDrop = { taskId, newStatus, order ->
                        service.updateTaskStatus(taskId, newStatus, order)
                    },
                    onEpicDrop = { epicId, newStatus ->
                        val epic = epicMeta[epicId] ?: return@TaskColumn
                        val epicTasks = tasks.filter { it.epicId == epicId }.sortedBy { it.order }
                        if (epicTasks.isEmpty()) return@TaskColumn
                        val existing = tasks.filter { displayStatus(it.status) == newStatus && it.epicId != epicId }
                        var order = existing.maxOfOrNull { it.order } ?: 0.0
                        for (task in epicTasks) {
                            order += 1.0
                            service.updateTaskStatus(task.id, newStatus, order)
                        }
                        val epicStatus = mapEpicStatus(newStatus)
                        service.updateEpicStatus(epicId, epicStatus, epic.order)
                    },
                    onOpen = { task ->
                        if (task.status == "AWAITING_APPROVAL") {
                            PlanReviewDialog(project, task, service).show()
                        } else {
                            TaskDetailDialog(project, task, service).show()
                        }
                    },
                    onDelete = { task ->
                        val result = Messages.showYesNoDialog(
                            project,
                            "Delete \"${task.title}\"? This cannot be undone.",
                            "Delete Task",
                            Messages.getWarningIcon()
                        )
                        if (result == Messages.YES) {
                            service.deleteTask(task.id)
                        }
                    },
                    onCreateTask = if (isBacklog) {
                        { CreateTaskDialog(project, state.epics, service).show() }
                    } else null
                )
                column.minimumSize = Dimension(BoardStyles.columnWidth, 0)
                column.maximumSize = Dimension(BoardStyles.columnWidth, Int.MAX_VALUE)
                board.add(column)
                board.add(Box.createHorizontalStrut(12))
            }

            val taskBoard = JBPanel<JBPanel<*>>().apply {
                layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.X_AXIS)
                isOpaque = false
                border = com.intellij.util.ui.JBUI.Borders.empty(8, 12, 12, 12)
            }
            buildTaskColumn(taskBoard, "Backlog", "BACKLOG", isBacklog = true)
            buildTaskColumn(taskBoard, "Planning", "PLANNING")
            buildTaskColumn(taskBoard, "Working", "WORKING")
            buildTaskColumn(taskBoard, "Review", "REVIEW")
            buildTaskColumn(taskBoard, "Done", "DONE")

            if (taskBoard.componentCount > 0) {
                taskBoard.remove(taskBoard.componentCount - 1)
            }

            val board = JBPanel<JBPanel<*>>(com.intellij.ui.components.panels.VerticalLayout(12)).apply {
                isOpaque = false
            }
            board.add(taskBoard)

            contentPanel.removeAll()
            contentPanel.add(board, BorderLayout.CENTER)
            contentPanel.revalidate()
            contentPanel.repaint()
        }
    }

    private fun updateEpicFilter(epics: List<com.moe.model.Epic>) {
        updatingEpicFilter = true
        val currentSelection = selectedEpicId
        val items = mutableListOf<EpicFilterItem>()
        items.add(EpicFilterItem("All Epics", null))
        for (epic in epics.sortedBy { it.order }) {
            items.add(EpicFilterItem(epic.title, epic.id))
        }
        epicFilter.model = javax.swing.DefaultComboBoxModel(items.toTypedArray())
        // Restore selection if it still exists
        val selectedIndex = if (currentSelection != null) {
            items.indexOfFirst { it.epicId == currentSelection }.takeIf { it >= 0 } ?: 0
        } else {
            0
        }
        epicFilter.selectedIndex = selectedIndex
        updatingEpicFilter = false
    }

    private fun reloadProjectSelector() {
        updatingSelector = true
        val currentPath = project.basePath
        val items = mutableListOf<ProjectItem>()
        if (currentPath != null) {
            items.add(ProjectItem("Current: ${project.name}", currentPath, false))
        }
        for (info in MoeProjectRegistry.listProjects()) {
            if (currentPath == null || !samePath(info.path, currentPath)) {
                items.add(ProjectItem("${info.name} — ${info.path}", info.path, false))
            }
        }
        items.add(ProjectItem("Browse…", null, true))

        projectSelector.model = javax.swing.DefaultComboBoxModel(items.toTypedArray())
        projectSelector.selectedIndex = 0
        updatingSelector = false
    }

    private fun chooseAndOpenProject() {
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
        descriptor.title = "Select Moe Project Folder"
        val selected = FileChooser.chooseFile(descriptor, project, null) ?: return
        openProject(selected.path)
        reloadProjectSelector()
    }

    private fun openProject(path: String?) {
        if (path.isNullOrBlank()) return
        val currentPath = project.basePath
        if (currentPath != null && samePath(currentPath, path)) {
            return
        }
        val root = File(path)
        if (!root.exists()) {
            Messages.showErrorDialog(project, "Folder does not exist: $path", "Moe")
            return
        }

        val moeDir = File(root, ".moe")
        if (!moeDir.exists()) {
            val init = Messages.showYesNoDialog(
                project,
                "This folder is not initialized for Moe. Initialize now?",
                "Initialize Moe",
                Messages.getQuestionIcon()
            )
            if (init == Messages.YES) {
                MoeProjectInitializer.initializeProject(root.absolutePath, root.name)
            } else {
                return
            }
        }

        MoeProjectRegistry.registerProject(root.absolutePath, root.name)
        ProjectUtil.openOrImport(root.absolutePath, project, true)
    }

    private fun samePath(a: String, b: String): Boolean {
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        return if (isWindows) a.equals(b, ignoreCase = true) else a == b
    }

    private data class ProjectItem(
        val label: String,
        val path: String?,
        val isBrowse: Boolean
    ) {
        override fun toString(): String = label
    }

    private data class EpicFilterItem(
        val label: String,
        val epicId: String?
    ) {
        override fun toString(): String = label
    }
}

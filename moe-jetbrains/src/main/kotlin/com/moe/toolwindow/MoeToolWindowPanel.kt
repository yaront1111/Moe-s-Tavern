package com.moe.toolwindow

import com.moe.model.MoeState
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.toolwindow.board.TaskColumn
import com.moe.toolwindow.board.BoardStyles
import com.moe.util.MoeBundle
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
import javax.swing.JMenu
import javax.swing.JMenuItem
import javax.swing.JPopupMenu
import javax.swing.JSeparator
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import javax.swing.Box
import javax.swing.JPanel
import javax.swing.JTabbedPane
import javax.swing.SwingUtilities

class MoeToolWindowPanel(private val project: Project) : JBPanel<MoeToolWindowPanel>(BorderLayout()), Disposable {
    private val service = project.service<MoeProjectService>()
    private val statusLabel = JBLabel(MoeBundle.message("moe.panel.disconnected"))
    private val contentPanel = JBPanel<JBPanel<*>>(BorderLayout())
    private val collapsedEpics = mutableSetOf<String>()
    private var lastState: MoeState? = null
    private val projectSelector = ComboBox<ProjectItem>()
    private var updatingSelector = false
    private val epicFilter = ComboBox<EpicFilterItem>()
    private var selectedEpicId: String? = null
    private var updatingEpicFilter = false
    private val workerPanel = WorkerPanel()
    private var stateListener: MoeStateListener? = null

    init {
        val header = JPanel(BorderLayout())
        header.border = com.intellij.util.ui.JBUI.Borders.empty(8, 12)
        header.isOpaque = false

        val title = JBLabel(MoeBundle.message("moe.panel.title")).apply {
            font = com.intellij.util.ui.JBUI.Fonts.label().deriveFont(java.awt.Font.BOLD, 15f)
            foreground = BoardStyles.textPrimary
        }

        styleStatusLabel(false, MoeBundle.message("moe.panel.disconnected"))

        val right = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0)).apply {
            isOpaque = false
        }
        right.add(JBLabel(MoeBundle.message("moe.panel.epicFilter")))
        epicFilter.preferredSize = Dimension(180, epicFilter.preferredSize.height)
        right.add(epicFilter)

        right.add(Box.createHorizontalStrut(8))
        right.add(JBLabel(MoeBundle.message("moe.panel.project")))
        projectSelector.preferredSize = Dimension(280, projectSelector.preferredSize.height)
        right.add(projectSelector)

        val addEpicButton = JBLabel(MoeBundle.message("moe.panel.addEpic")).apply {
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

        val agentsButton = JBLabel(MoeBundle.message("moe.panel.startAgents")).apply {
            isOpaque = true
            background = BoardStyles.columnHeaderBackground
            foreground = BoardStyles.textPrimary
            border = com.intellij.util.ui.JBUI.Borders.empty(4, 8)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    val popup = JPopupMenu()

                    fun launchWithProvider(role: String?, provider: TerminalAgentLauncher.AgentProvider) {
                        val command = if (provider == TerminalAgentLauncher.AgentProvider.CUSTOM) {
                            val current = TerminalAgentLauncher.getCustomCommand(project)
                            val input = Messages.showInputDialog(
                                project,
                                MoeBundle.message("moe.panel.agentsMenu.customPrompt"),
                                MoeBundle.message("moe.panel.agentsMenu.customTitle"),
                                null,
                                current.ifEmpty { null },
                                null
                            ) ?: return
                            if (input.isBlank()) return
                            TerminalAgentLauncher.setCustomCommand(project, input)
                            TerminalAgentLauncher.setLastUsedProvider(project, provider)
                            input
                        } else {
                            TerminalAgentLauncher.setLastUsedProvider(project, provider)
                            provider.command
                        }
                        if (role != null) {
                            TerminalAgentLauncher.startAgent(project, role, command)
                        } else {
                            TerminalAgentLauncher.startAgents(project, command)
                        }
                    }

                    fun buildProviderMenu(label: String, role: String?): JMenu {
                        val menu = JMenu(label)
                        val lastUsed = TerminalAgentLauncher.getLastUsedProvider(project)
                        for (provider in TerminalAgentLauncher.AgentProvider.entries) {
                            val name = MoeBundle.message("moe.panel.provider.${provider.name.lowercase()}")
                            val suffix = if (provider == lastUsed) " \u2713" else ""
                            menu.add(JMenuItem(name + suffix).apply {
                                addActionListener { launchWithProvider(role, provider) }
                            })
                        }
                        return menu
                    }

                    popup.add(buildProviderMenu(MoeBundle.message("moe.panel.agentsMenu.all"), null))
                    popup.add(JSeparator())
                    popup.add(buildProviderMenu(MoeBundle.message("moe.panel.agentsMenu.architect"), "architect"))
                    popup.add(buildProviderMenu(MoeBundle.message("moe.panel.agentsMenu.worker"), "worker"))
                    popup.add(buildProviderMenu(MoeBundle.message("moe.panel.agentsMenu.qa"), "qa"))
                    popup.show(e.component, e.x, e.y)
                }
            })
        }
        right.add(agentsButton)

        val settingsButton = JBLabel("\u2699").apply {
            isOpaque = true
            background = BoardStyles.columnHeaderBackground
            foreground = BoardStyles.textPrimary
            border = com.intellij.util.ui.JBUI.Borders.empty(4, 8)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            toolTipText = MoeBundle.message("moe.panel.settings.tooltip")
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    val currentState = service.getState()
                    val currentSettings = currentState?.project?.settings
                    MoeSettingsDialog(project, service, currentSettings).show()
                }
            })
        }
        right.add(settingsButton)

        right.add(statusLabel)

        header.add(title, BorderLayout.WEST)
        header.add(right, BorderLayout.EAST)

        val topPanel = JPanel(BorderLayout()).apply {
            isOpaque = false
            add(header, BorderLayout.NORTH)
            add(workerPanel, BorderLayout.SOUTH)
        }
        add(topPanel, BorderLayout.NORTH)
        background = BoardStyles.boardBackground
        contentPanel.background = BoardStyles.boardBackground

        val scroll = JBScrollPane(contentPanel).apply {
            border = com.intellij.util.ui.JBUI.Borders.empty()
            viewport.background = BoardStyles.boardBackground
        }

        val proposalPanel = ProposalPanel(project)
        val activityLogPanel = ActivityLogPanel(project)

        val tabbedPane = JTabbedPane().apply {
            addTab(MoeBundle.message("moe.tab.board"), scroll)
            addTab(MoeBundle.message("moe.tab.proposals"), proposalPanel)
            addTab(MoeBundle.message("moe.tab.activityLog"), activityLogPanel)
        }
        add(tabbedPane, BorderLayout.CENTER)

        // Register child disposables
        Disposer.register(this, proposalPanel)
        Disposer.register(this, activityLogPanel)

        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {
                updateBoard(state)
            }

            override fun onStatus(connected: Boolean, message: String) {
                styleStatusLabel(connected, message)
            }

            override fun onError(operation: String, message: String) {
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("Moe Notifications")
                    .createNotification(MoeBundle.message("moe.notification.error"), MoeBundle.message("moe.notification.operationFailed", operation, message), NotificationType.ERROR)
                    .notify(project)
            }
        }
        service.addListener(stateListener!!)

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
        statusLabel.text = if (connected) MoeBundle.message("moe.panel.connected") else message
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

            // Update worker panel
            val taskMap = state.tasks.associateBy { it.id }
            workerPanel.updateWorkers(state.workers, taskMap)

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
                            MoeBundle.message("moe.message.deleteTask", task.title),
                            MoeBundle.message("moe.message.deleteTaskTitle"),
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
            buildTaskColumn(taskBoard, MoeBundle.message("moe.column.backlog"), "BACKLOG", isBacklog = true)
            buildTaskColumn(taskBoard, MoeBundle.message("moe.column.planning"), "PLANNING")
            buildTaskColumn(taskBoard, MoeBundle.message("moe.column.working"), "WORKING")
            buildTaskColumn(taskBoard, MoeBundle.message("moe.column.review"), "REVIEW")
            buildTaskColumn(taskBoard, MoeBundle.message("moe.column.done"), "DONE")

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
        items.add(EpicFilterItem(MoeBundle.message("moe.panel.allEpics"), null))
        for (epic in epics.sortedBy { it.order }) {
            items.add(EpicFilterItem(epic.title, epic.id))
        }
        epicFilter.model = javax.swing.DefaultComboBoxModel(items.toTypedArray())
        // Restore selection if it still exists, otherwise reset to "All Epics"
        val foundIndex = if (currentSelection != null) {
            items.indexOfFirst { it.epicId == currentSelection }
        } else {
            -1
        }
        val selectedIndex = if (foundIndex >= 0) {
            foundIndex
        } else {
            // Selected epic was deleted or not set - reset to "All Epics"
            selectedEpicId = null
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
            items.add(ProjectItem(MoeBundle.message("moe.panel.currentProject", project.name), currentPath, false))
        }
        for (info in MoeProjectRegistry.listProjects()) {
            if (currentPath == null || !samePath(info.path, currentPath)) {
                items.add(ProjectItem("${info.name} — ${info.path}", info.path, false))
            }
        }
        items.add(ProjectItem(MoeBundle.message("moe.panel.browse"), null, true))

        projectSelector.model = javax.swing.DefaultComboBoxModel(items.toTypedArray())
        projectSelector.selectedIndex = 0
        updatingSelector = false
    }

    private fun chooseAndOpenProject() {
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
        descriptor.title = MoeBundle.message("moe.dialog.selectFolder")
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
            Messages.showErrorDialog(project, MoeBundle.message("moe.message.folderNotExist", path), "Moe")
            return
        }

        val moeDir = File(root, ".moe")
        if (!moeDir.exists()) {
            val init = Messages.showYesNoDialog(
                project,
                MoeBundle.message("moe.message.initNotMoe"),
                MoeBundle.message("moe.dialog.initMoe"),
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

    override fun dispose() {
        stateListener?.let { service.removeListener(it) }
        stateListener = null
    }
}

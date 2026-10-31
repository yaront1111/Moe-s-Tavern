package com.moe.toolwindow

import com.moe.services.MoeDaemonSupervisor
import com.moe.util.MoeBundle
import com.moe.util.RuntimeProfile
import com.moe.util.RuntimeSelection
import com.moe.util.RuntimeSelectionPolicy
import com.moe.util.TerminalAgentLauncher
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.openapi.Disposable
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.ui.table.JBTable
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.event.HierarchyEvent
import java.io.IOException
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.table.DefaultTableModel

/** Resolves a text with the plugin bundle; a nested text argument resolves first. */
internal fun ManagedVmText.resolve(): String =
    MoeBundle.message(key, *args.map { if (it is ManagedVmText) it.resolve() else it }.toTypedArray())

/**
 * The Managed VMs tab: Moe-owned local VMs as the bundled `vm-control.mjs` reports them ([ManagedVmPresentation]).
 * One run at a time, off the EDT, as a list of arguments (never a shell). Only stdout and the exit code are read:
 * stderr is discarded. The panel never writes `.moe/` and never sends settings.
 */
class ManagedVmPanel(private val project: Project) : JBPanel<ManagedVmPanel>(BorderLayout()), Disposable {
    private val basePath = project.basePath.orEmpty()
    private val readiness = List(3) { note() }
    private val notes = note()
    private val tableModel = object : DefaultTableModel(ManagedVmKeys.COLUMNS.map { MoeBundle.message(it) }.toTypedArray(), 0) {
        override fun isCellEditable(row: Int, column: Int) = false
    }
    private val refreshButton = button(ManagedVmKeys.BUTTON_REFRESH) { actionNotes = emptyList(); run(ManagedVmCommand.STATUS) }
    private val reconcileButton = button(ManagedVmKeys.BUTTON_RECONCILE) { run(ManagedVmCommand.RECONCILE) }
    private val cleanupButton = button(ManagedVmKeys.BUTTON_CLEANUP) { confirmCleanup() }
    // EDT-only state, except disposed and indicator: dispose and the background run each check the other's.
    private var lastStatus: ManagedVmReport? = null
    private var statusNotes = emptyList<ManagedVmText>()
    private var actionNotes = emptyList<ManagedVmText>()
    private var running = false
    @Volatile private var disposed = false
    @Volatile private var indicator: ProgressIndicator? = null

    init {
        border = JBUI.Borders.empty(8)
        val buttons = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
            isOpaque = false
            listOf(refreshButton, reconcileButton, cleanupButton).forEach { add(it) }
        }
        val top = JPanel(VerticalLayout(4)).apply {
            isOpaque = false
            add(note().apply { text = MoeBundle.message(ManagedVmKeys.INTRO) })
            readiness.forEach { add(it) }
            add(note().apply { text = ManagedVmPresentation.strongProfile(null).resolve() })
            add(buttons)
        }
        add(top, BorderLayout.NORTH)
        add(JBScrollPane(JBTable(tableModel)), BorderLayout.CENTER)
        add(notes, BorderLayout.SOUTH)
        // Refresh once, the first time the tab is shown.
        addHierarchyListener { event ->
            val shown = (event.changeFlags and HierarchyEvent.SHOWING_CHANGED.toLong()) != 0L && isShowing
            if (shown && lastStatus == null) run(ManagedVmCommand.STATUS)
        }
        render()
    }

    override fun dispose() {
        disposed = true
        indicator?.cancel()
    }

    private fun run(command: ManagedVmCommand) {
        val allowed = ManagedVmPresentation.actions(lastStatus, running)
        val permitted = when (command) {
            ManagedVmCommand.STATUS -> allowed.refresh
            ManagedVmCommand.RECONCILE -> allowed.reconcile
            ManagedVmCommand.CLEANUP -> allowed.cleanup
        }
        if (disposed || !permitted) return
        running = true
        render()
        object : Task.Backgroundable(project, MoeBundle.message(ManagedVmKeys.TAB), true) {
            private var report: ManagedVmReport = ManagedVmReport.Unreadable(ManagedVmKeys.FAILED)

            override fun run(progress: ProgressIndicator) {
                indicator = progress
                if (disposed) progress.cancel()
                report = execute(command, progress)
            }

            override fun onFinished() {
                indicator = null
                running = false
                if (!disposed) show(command, report)
            }
        }.queue()
    }

    /** Background thread. A missing script or node starts no process. */
    private fun execute(command: ManagedVmCommand, progress: ProgressIndicator): ManagedVmReport {
        val script = TerminalAgentLauncher.resolveBundledPath("scripts/local-runner/vm-control.mjs")
            ?: return ManagedVmReport.Unreadable(ManagedVmKeys.SCRIPT_MISSING)
        val supervisor = MoeDaemonSupervisor(basePath, project.name)
        val isProtected = RuntimeSelectionPolicy.profile(basePath) == RuntimeProfile.PROTECTED
        val node = nodeCommand(supervisor, isProtected) ?: return ManagedVmReport.Unreadable(ManagedVmKeys.NODE_MISSING)
        val builder = ProcessBuilder(listOf(node) + command.args(script.path, basePath))
            .directory(script.parentFile)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
        if (isProtected) supervisor.protectedDaemonEnvironment(builder.environment(), basePath)
        if (progress.isCanceled) return ManagedVmReport.Unreadable(ManagedVmKeys.CANCELLED)
        return try {
            val handler = CapturingProcessHandler(builder.start(), Charsets.UTF_8, builder.command().joinToString(" "))
            val output = handler.runProcessWithProgressIndicator(progress, command.timeoutMs.toInt())
            if (output.isCancelled) ManagedVmReport.Unreadable(ManagedVmKeys.CANCELLED)
            else ManagedVmPresentation.decode(command, output.stdout, output.exitCode, output.isTimeout)
        } catch (_: IOException) {
            ManagedVmReport.Unreadable(ManagedVmKeys.FAILED)
        }
    }

    /** The node the daemon supervisor would pick for this profile (MoeDaemonSupervisor.protectedCommandOrRefuse). */
    private fun nodeCommand(supervisor: MoeDaemonSupervisor, isProtected: Boolean): String? {
        if (!isProtected) return supervisor.resolveNodeExecutable()
        val node = supervisor.resolveNodeExecutable(nodeOnPath = { supervisor.nodeOnProtectedPath(System.getenv("PATH").orEmpty(), basePath) })
        return (RuntimeSelectionPolicy.installedExecutable(node, basePath) as? RuntimeSelection.Accepted)?.file?.path
    }

    private fun show(command: ManagedVmCommand, report: ManagedVmReport) {
        if (command == ManagedVmCommand.STATUS) {
            lastStatus = report
            statusNotes = ManagedVmPresentation.notes(report)
        } else {
            actionNotes = ManagedVmPresentation.notes(report)
        }
        render()
        // Reconcile and cleanup change what status reports.
        if (command != ManagedVmCommand.STATUS) run(ManagedVmCommand.STATUS)
    }

    private fun render() {
        ManagedVmPresentation.readiness(lastStatus).zip(readiness).forEach { (text, area) -> area.text = text.resolve() }
        tableModel.rowCount = 0
        ManagedVmPresentation.rows(lastStatus).forEach { tableModel.addRow(arrayOf<Any>(it.instance, it.phase, it.state, it.launchTries, it.taskId)) }
        notes.text = (statusNotes + actionNotes).joinToString("\n") { it.resolve() }
        val allowed = ManagedVmPresentation.actions(lastStatus, running)
        refreshButton.isEnabled = allowed.refresh
        reconcileButton.isEnabled = allowed.reconcile
        cleanupButton.isEnabled = allowed.cleanup
    }

    private fun confirmCleanup() {
        val title = MoeBundle.message(ManagedVmKeys.BUTTON_CLEANUP)
        val message = MoeBundle.message(ManagedVmKeys.CLEANUP_CONFIRM)
        val choice = Messages.showOkCancelDialog(project, message, title, title, MoeBundle.message(AccountKeys.CANCEL), Messages.getWarningIcon())
        if (choice == Messages.OK) run(ManagedVmCommand.CLEANUP)
    }

    private fun button(key: String, action: () -> Unit) = JButton(MoeBundle.message(key)).apply { addActionListener { action() } }

    /** Read-only wrapping text, never rendered as HTML. */
    private fun note() = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        isOpaque = false
        font = JBUI.Fonts.label()
    }
}

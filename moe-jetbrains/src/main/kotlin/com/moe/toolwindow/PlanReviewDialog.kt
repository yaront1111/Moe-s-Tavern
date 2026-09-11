package com.moe.toolwindow

import com.moe.model.MoeState
import com.moe.model.Task
import com.moe.model.TaskComment
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.util.MoeBundle
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.Font
import javax.swing.Action
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSplitPane
import javax.swing.JTextArea
import javax.swing.SwingUtilities
import javax.swing.Timer

class PlanReviewDialog(
    private val ideaProject: Project,
    private var task: Task,
    private val service: MoeProjectService
) : DialogWrapper(ideaProject), MoeStateListener {

    private val log = Logger.getInstance(PlanReviewDialog::class.java)
    private var pendingUpdate: Runnable? = null
    private var debounceTimer: Timer? = null

    /**
     * Binds approval to the plan revision that actually rendered here. Every
     * decision lives in the (headless, tested) state machine; this dialog only
     * applies the results.
     */
    private val approval = PlanReviewApprovalState(task.id)
    private var approveAction: Action? = null

    /** Written on the daemon message thread, read on the event dispatch thread. */
    @Volatile
    private var lastErrorMessage: String = ""
    private val noticeLabel = JBLabel().apply {
        isVisible = false
        foreground = JBColor.RED
        font = JBUI.Fonts.smallFont()
    }

    private lateinit var commentsPanel: JPanel
    private lateinit var commentsScroll: JScrollPane

    init {
        title = MoeBundle.message("moe.dialog.planReview")
        service.addListener(this)
        init()
    }

    override fun createCenterPanel(): JComponent {
        val container = JPanel(BorderLayout())
        container.preferredSize = Dimension(800, 500)
        try {
            buildReviewContent(container)
            // Only now — the Definition of Done and the steps are on screen and
            // nothing threw — is this the revision the reviewer actually read.
            approval.onRendered(snapshotOf(task))
        } catch (ex: Exception) {
            // Fail closed: an unrendered plan was never reviewed, so the machine
            // stays uncaptured and the approve button stays disabled.
            log.warn("Failed to render the plan under review; approval stays disabled", ex)
        }
        applyApprovalState()
        return container
    }

    private fun buildReviewContent(container: JPanel) {
        val leftPanel = createDodPanel()
        val rightPanel = createStepsPanel()

        val splitPane = JSplitPane(JSplitPane.HORIZONTAL_SPLIT, leftPanel, rightPanel).apply {
            dividerLocation = 300
            border = JBUI.Borders.empty()
        }

        // Task info header
        val header = JPanel(VerticalLayout(4)).apply {
            border = JBUI.Borders.empty(8)
            add(JBLabel(task.title).apply {
                font = font.deriveFont(Font.BOLD, 14f)
            })
            if (task.description.isNotBlank()) {
                add(JBLabel(task.description).apply {
                    font = JBUI.Fonts.smallFont()
                })
            }
            add(noticeLabel)
        }

        container.add(header, BorderLayout.NORTH)
        container.add(splitPane, BorderLayout.CENTER)
        container.add(buildCommentsSection(), BorderLayout.SOUTH)
    }

    private fun buildCommentsSection(): JComponent {
        // Comments section
        val commentsSection = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(8)
        }
        commentsSection.add(JBLabel(MoeBundle.message("moe.label.comments")).apply {
            border = JBUI.Borders.emptyBottom(4)
        }, BorderLayout.NORTH)

        commentsPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
        }
        renderComments(task.comments ?: emptyList())

        commentsScroll = JScrollPane(commentsPanel)
        commentsScroll.preferredSize = Dimension(780, 100)
        commentsScroll.border = JBUI.Borders.empty()
        commentsSection.add(commentsScroll, BorderLayout.CENTER)

        val askPanel = JPanel(BorderLayout()).apply { isOpaque = false }
        val questionField = JBTextField().apply {
            toolTipText = MoeBundle.message("moe.message.typeQuestion")
        }
        val askButton = JButton(MoeBundle.message("moe.button.askQuestion"))
        askButton.addActionListener {
            val text = questionField.text.trim()
            if (text.isNotEmpty()) {
                service.addTaskComment(task.id, text)
                questionField.text = ""
            }
        }
        askPanel.add(questionField, BorderLayout.CENTER)
        askPanel.add(askButton, BorderLayout.EAST)
        commentsSection.add(askPanel, BorderLayout.SOUTH)

        return commentsSection
    }

    /** Reads only what the approval machine is allowed to see. */
    private fun snapshotOf(candidate: Task?): PlanReviewApprovalState.TaskSnapshot =
        PlanReviewApprovalState.TaskSnapshot(
            present = candidate != null,
            status = candidate?.status,
            revision = PlanReviewApprovalState.tokenOf(candidate?.planRevision)
        )

    /**
     * Pushes the machine's current verdict onto the screen. Must run on the event
     * dispatch thread; it is the only place the dialog closes on an approval, and
     * it does so only once the machine has seen authoritative state.
     */
    private fun applyApprovalState() {
        approveAction?.isEnabled = approval.approveEnabled
        val key = approval.noticeKey
        if (key == null) {
            noticeLabel.isVisible = false
            noticeLabel.text = ""
        } else {
            showNotice(key)
        }
        if (approval.currentPhase == PlanReviewApprovalState.Phase.FINISHED) {
            close(OK_EXIT_CODE)
        }
    }

    /**
     * [key] is always a MoeBundle key, so the daemon's own text can only ever
     * appear as a parameter after a literal prefix. That matters: a JBLabel
     * renders as HTML when the text STARTS with an html tag, and agent/daemon
     * text is arbitrary.
     */
    private fun showNotice(key: String) {
        noticeLabel.text = MoeBundle.message(key, lastErrorMessage)
        noticeLabel.isVisible = true
    }

    private fun renderComments(comments: List<TaskComment>) {
        commentsPanel.removeAll()

        if (comments.isEmpty()) {
            commentsPanel.add(JBLabel(MoeBundle.message("moe.message.noComments")).apply {
                foreground = JBColor.GRAY
                font = JBUI.Fonts.smallFont()
            })
        } else {
            for (comment in comments) {
                val isHuman = comment.author == "human"
                val commentRow = JPanel(BorderLayout()).apply {
                    isOpaque = true
                    background = if (isHuman) {
                        JBColor(Color(230, 240, 255), Color(40, 50, 70))
                    } else {
                        JBColor(Color(240, 255, 240), Color(40, 60, 40))
                    }
                    border = JBUI.Borders.empty(4, 8)
                }
                val commentHeader = JBLabel("${comment.author} - ${comment.timestamp.take(19)}").apply {
                    foreground = JBColor.GRAY
                    font = JBUI.Fonts.smallFont()
                }
                val body = JBLabel("<html>${comment.content.replace("\n", "<br>")}</html>")
                commentRow.add(commentHeader, BorderLayout.NORTH)
                commentRow.add(body, BorderLayout.CENTER)
                commentsPanel.add(commentRow)
            }
        }

        commentsPanel.revalidate()
        commentsPanel.repaint()

        // Scroll to bottom to show latest comment
        SwingUtilities.invokeLater {
            val scrollBar = commentsScroll.verticalScrollBar
            scrollBar.value = scrollBar.maximum
        }
    }

    override fun onState(state: MoeState) {
        val updated = state.tasks.find { it.id == task.id }

        // The approval machine runs FIRST: strictly before the comments-equality
        // early return below and outside the comment debounce. A plan whose steps
        // or Definition of Done changed can carry byte-identical comments, and
        // that case used to leave the screen showing a plan nobody could see had
        // been replaced.
        if (approval.onStateUpdate(snapshotOf(updated))) {
            SwingUtilities.invokeLater {
                if (isDisposed) return@invokeLater
                try {
                    applyApprovalState()
                } catch (ex: Exception) {
                    log.warn("Failed to apply the plan approval state", ex)
                }
            }
        }

        if (updated == null) return
        val oldComments = task.comments ?: emptyList()
        val newComments = updated.comments ?: emptyList()
        task = updated
        if (oldComments == newComments) {
            return
        }

        pendingUpdate = Runnable {
            if (isDisposed) return@Runnable
            try {
                renderComments(task.comments ?: emptyList())
            } catch (ex: Exception) {
                log.warn("Failed to render plan review comments", ex)
            }
        }

        SwingUtilities.invokeLater {
            if (isDisposed) return@invokeLater
            try {
                debounceTimer?.stop()
                debounceTimer = Timer(DEBOUNCE_MS) {
                    val update = pendingUpdate ?: return@Timer
                    pendingUpdate = null
                    if (isDisposed) return@Timer
                    update.run()
                }.apply {
                    isRepeats = false
                    start()
                }
            } catch (ex: Exception) {
                log.warn("Failed to schedule debounced comment update", ex)
            }
        }
    }

    override fun onStatus(connected: Boolean, message: String) {}

    /**
     * A daemon ERROR frame. Only meaningful while an approval is in flight, and
     * even then it is failure feedback, never an approval: the machine drops back
     * to a usable state and the dialog stays open with the daemon's own message.
     */
    override fun onError(operation: String, message: String) {
        if (!approval.onDaemonError(operation, message)) return
        // Bounded: this is arbitrary daemon text and it lands in a header label.
        lastErrorMessage = message.take(MAX_ERROR_CHARS)
        SwingUtilities.invokeLater {
            if (isDisposed) return@invokeLater
            try {
                applyApprovalState()
            } catch (ex: Exception) {
                log.warn("Failed to apply the daemon error to the plan review", ex)
            }
        }
    }

    override fun dispose() {
        // Terminal first: nothing already queued may send after teardown.
        approval.onDisposed()
        debounceTimer?.stop()
        debounceTimer = null
        pendingUpdate = null
        service.removeListener(this)
        super.dispose()
    }

    private fun createDodPanel(): JComponent {
        val panel = JPanel(VerticalLayout(8))
        panel.border = JBUI.Borders.empty(8)

        panel.add(JBLabel(MoeBundle.message("moe.label.definitionOfDone")).apply {
            font = font.deriveFont(Font.BOLD)
        })

        if (task.definitionOfDone.isEmpty()) {
            panel.add(JBLabel(MoeBundle.message("moe.message.noCriteriaDefined")).apply {
                font = JBUI.Fonts.smallFont()
                foreground = java.awt.Color.GRAY
            })
        } else {
            for (criterion in task.definitionOfDone) {
                val item = JPanel(BorderLayout()).apply {
                    isOpaque = false
                    border = JBUI.Borders.empty(2, 0)
                }
                item.add(JBLabel("\u2022 $criterion"), BorderLayout.CENTER)
                panel.add(item)
            }
        }

        val scrollPane = JBScrollPane(panel)
        scrollPane.border = BorderFactory.createTitledBorder(MoeBundle.message("moe.label.acceptanceCriteria"))
        return scrollPane
    }

    private fun createStepsPanel(): JComponent {
        val panel = JPanel(VerticalLayout(12))
        panel.border = JBUI.Borders.empty(8)

        panel.add(JBLabel(MoeBundle.message("moe.label.implementationPlan")).apply {
            font = font.deriveFont(Font.BOLD)
        })

        if (task.implementationPlan.isEmpty()) {
            panel.add(JBLabel(MoeBundle.message("moe.message.noPlanDefined")).apply {
                font = JBUI.Fonts.smallFont()
                foreground = java.awt.Color.GRAY
            })
        } else {
            for ((index, step) in task.implementationPlan.withIndex()) {
                val stepPanel = JPanel(VerticalLayout(4)).apply {
                    border = BorderFactory.createCompoundBorder(
                        BorderFactory.createMatteBorder(0, 3, 0, 0, getStatusColor(step.status)),
                        JBUI.Borders.empty(4, 8)
                    )
                    isOpaque = true
                    background = JBUI.CurrentTheme.ToolWindow.background()
                }

                stepPanel.add(JBLabel(MoeBundle.message("moe.message.stepStatus", index + 1, step.status)).apply {
                    font = JBUI.Fonts.smallFont().deriveFont(Font.BOLD)
                })

                val descArea = JTextArea(step.description).apply {
                    lineWrap = true
                    wrapStyleWord = true
                    isEditable = false
                    isOpaque = false
                    font = JBUI.Fonts.label()
                }
                stepPanel.add(descArea)

                if (step.affectedFiles.isNotEmpty()) {
                    stepPanel.add(JBLabel(MoeBundle.message("moe.message.affectedFiles")).apply {
                        font = JBUI.Fonts.smallFont()
                        foreground = java.awt.Color.GRAY
                    })
                    for (file in step.affectedFiles) {
                        stepPanel.add(JBLabel("  \u2022 $file").apply {
                            font = JBUI.Fonts.smallFont()
                        })
                    }
                }

                panel.add(stepPanel)
            }
        }

        val scrollPane = JBScrollPane(panel)
        scrollPane.border = BorderFactory.createTitledBorder("Steps")
        return scrollPane
    }

    private fun getStatusColor(status: String): java.awt.Color {
        return when (status) {
            "DONE" -> java.awt.Color(76, 175, 80)
            "IN_PROGRESS" -> java.awt.Color(33, 150, 243)
            else -> java.awt.Color(158, 158, 158)
        }
    }

    override fun createActions(): Array<Action> {
        val approveAction = object : DialogWrapperAction(MoeBundle.message("moe.button.approve")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                // Re-check independently of the button state: a caller that
                // reaches this method anyway still cannot send a stale approval.
                val fresh = service.getState()?.tasks?.find { it.id == task.id }
                val decision = approval.onApproveClicked(service.isConnected(), snapshotOf(fresh))
                lastErrorMessage = ""
                when (decision) {
                    is PlanReviewApprovalState.Decision.Send -> sendApproval(decision)
                    is PlanReviewApprovalState.Decision.Blocked -> {
                        // Stay open. The reviewer keeps the plan and the reason.
                        applyApprovalState()
                        showNotice(decision.messageKey)
                    }
                }
            }
        }
        approveAction.isEnabled = approval.approveEnabled
        this.approveAction = approveAction

        val rejectAction = object : DialogWrapperAction(MoeBundle.message("moe.button.reject")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val reason = Messages.showInputDialog(
                    ideaProject,
                    MoeBundle.message("moe.message.rejectReason"),
                    MoeBundle.message("moe.button.reject"),
                    Messages.getQuestionIcon()
                )
                if (reason != null && reason.isNotBlank()) {
                    service.rejectTask(task.id, reason)
                    close(OK_EXIT_CODE)
                }
            }
        }

        return arrayOf(approveAction, rejectAction, cancelAction)
    }

    /**
     * Hands the captured revision to the command layer. A transport that accepted
     * the bytes is NOT an approval, so this never closes the dialog: only the
     * daemon moving the task on can do that, via [onState].
     */
    private fun sendApproval(send: PlanReviewApprovalState.Decision.Send) {
        // The machine is already PENDING, so this disarms the button before the
        // command goes out and a second click cannot reach the socket.
        applyApprovalState()
        val delivered = try {
            service.approveTask(send.taskId, send.expectedPlanRevision)
        } catch (ex: Exception) {
            log.warn("Failed to send the plan approval", ex)
            false
        }
        if (!delivered && approval.onSendFailed()) {
            applyApprovalState()
        }
    }

    companion object {
        private const val DEBOUNCE_MS = 200
        private const val MAX_ERROR_CHARS = 300
    }
}

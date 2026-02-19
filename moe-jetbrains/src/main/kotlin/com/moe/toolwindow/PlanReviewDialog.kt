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

    private lateinit var commentsPanel: JPanel
    private lateinit var commentsScroll: JScrollPane

    init {
        title = MoeBundle.message("moe.dialog.planReview")
        service.addListener(this)
        init()
    }

    override fun createCenterPanel(): JComponent {
        val leftPanel = createDodPanel()
        val rightPanel = createStepsPanel()

        val splitPane = JSplitPane(JSplitPane.HORIZONTAL_SPLIT, leftPanel, rightPanel).apply {
            dividerLocation = 300
            border = JBUI.Borders.empty()
        }

        val container = JPanel(BorderLayout())
        container.preferredSize = Dimension(800, 500)

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
        }

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

        container.add(header, BorderLayout.NORTH)
        container.add(splitPane, BorderLayout.CENTER)
        container.add(commentsSection, BorderLayout.SOUTH)

        return container
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
        val updated = state.tasks.find { it.id == task.id } ?: return
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

    override fun dispose() {
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
                service.approveTask(task.id)
                close(OK_EXIT_CODE)
            }
        }

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

    companion object {
        private const val DEBOUNCE_MS = 200
    }
}

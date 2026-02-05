package com.moe.toolwindow

import com.moe.model.Task
import com.moe.services.MoeProjectService
import com.moe.util.MoeBundle
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import javax.swing.Action
import javax.swing.BorderFactory
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JSplitPane
import javax.swing.JTextArea

class PlanReviewDialog(
    private val ideaProject: Project,
    private val task: Task,
    private val service: MoeProjectService
) : DialogWrapper(ideaProject) {

    init {
        title = MoeBundle.message("moe.dialog.planReview")
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

        container.add(header, BorderLayout.NORTH)
        container.add(splitPane, BorderLayout.CENTER)

        return container
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
}

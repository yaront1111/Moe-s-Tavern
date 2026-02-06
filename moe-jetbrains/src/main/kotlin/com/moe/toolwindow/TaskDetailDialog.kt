package com.moe.toolwindow

import com.moe.model.Task
import com.moe.model.ImplementationStep
import com.moe.services.MoeProjectService
import com.moe.util.MoeBundle
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.Action
import javax.swing.JScrollPane

class TaskDetailDialog(
    private val project: Project,
    private val task: Task,
    private val service: MoeProjectService
) : DialogWrapper(project) {

    private val titleField = JBTextField(task.title)
    private val priorityCombo = ComboBox(arrayOf("CRITICAL", "HIGH", "MEDIUM", "LOW"))
    private val descriptionField = JBTextArea(task.description)
    private val dodField = JBTextArea(task.definitionOfDone.joinToString("\n"))

    init {
        title = MoeBundle.message("moe.dialog.taskDetail", task.title)
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(VerticalLayout(8))
        panel.border = JBUI.Borders.empty(4)
        panel.add(JBLabel(MoeBundle.message("moe.message.statusPrefix", task.status)))

        panel.add(JBLabel(MoeBundle.message("moe.label.priority")))
        priorityCombo.selectedItem = task.priority
        priorityCombo.maximumSize = Dimension(520, priorityCombo.preferredSize.height)
        panel.add(priorityCombo)

        panel.add(JBLabel(MoeBundle.message("moe.label.title")))
        titleField.maximumSize = Dimension(520, titleField.preferredSize.height)
        panel.add(titleField)

        panel.add(JBLabel(MoeBundle.message("moe.label.description")))
        descriptionField.lineWrap = true
        descriptionField.wrapStyleWord = true
        descriptionField.minimumSize = Dimension(360, 140)
        val descriptionScroll = JScrollPane(descriptionField)
        descriptionScroll.preferredSize = Dimension(520, 140)
        panel.add(descriptionScroll)

        panel.add(JBLabel(MoeBundle.message("moe.label.definitionOfDone")))
        dodField.lineWrap = true
        dodField.wrapStyleWord = true
        dodField.minimumSize = Dimension(360, 120)
        val dodScroll = JScrollPane(dodField)
        dodScroll.preferredSize = Dimension(520, 120)
        panel.add(dodScroll)

        // Implementation Plan section
        if (task.implementationPlan.isNotEmpty()) {
            val planPanel = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                border = BorderFactory.createTitledBorder(
                    JBUI.Borders.customLine(JBColor.border()),
                    MoeBundle.message("moe.label.implementationPlan")
                )
            }

            for ((index, step) in task.implementationPlan.withIndex()) {
                planPanel.add(createStepRow(index + 1, step))
            }

            val planScroll = JScrollPane(planPanel)
            planScroll.preferredSize = Dimension(520, 160)
            planScroll.border = JBUI.Borders.empty()
            panel.add(planScroll)
        }

        task.prLink?.let { panel.add(JBLabel(MoeBundle.message("moe.message.prLink", it))) }
        task.reopenReason?.let { panel.add(JBLabel(MoeBundle.message("moe.message.reopenReasonLabel", it))) }

        return panel
    }

    private fun createStepRow(stepNumber: Int, step: ImplementationStep): JPanel {
        val statusColor = when (step.status) {
            "COMPLETED" -> JBColor(Color(34, 139, 34), Color(50, 205, 50)) // Green
            "IN_PROGRESS" -> JBColor(Color(30, 144, 255), Color(65, 105, 225)) // Blue
            else -> JBColor.GRAY // PENDING
        }

        val statusIcon = when (step.status) {
            "COMPLETED" -> "✓"
            "IN_PROGRESS" -> "▶"
            else -> "○"
        }

        val row = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4, 8)
            isOpaque = false
        }

        val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
            isOpaque = false
        }

        val iconLabel = JBLabel(statusIcon).apply {
            foreground = statusColor
            font = font.deriveFont(Font.BOLD)
        }
        leftPanel.add(iconLabel)

        val descLabel = JBLabel("$stepNumber. ${step.description}").apply {
            if (step.status == "IN_PROGRESS") {
                foreground = statusColor
                font = font.deriveFont(Font.BOLD)
            } else if (step.status == "COMPLETED") {
                foreground = statusColor
            }
        }
        leftPanel.add(descLabel)

        row.add(leftPanel, BorderLayout.CENTER)

        if (step.affectedFiles.isNotEmpty()) {
            val filesLabel = JBLabel(step.affectedFiles.joinToString(", ")).apply {
                foreground = JBColor.GRAY
                font = font.deriveFont(font.size - 1f)
            }
            row.add(filesLabel, BorderLayout.SOUTH)
        }

        return row
    }

    override fun createActions(): Array<Action> {
        val actions = mutableListOf<Action>()

        actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.save")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val newTitle = titleField.text.trim().ifEmpty { task.title }
                val newDesc = descriptionField.text.trim()
                val dod = dodField.text
                    .lineSequence()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .toList()
                val finalDod = if (dod.isEmpty()) task.definitionOfDone else dod
                val newPriority = priorityCombo.selectedItem as? String ?: task.priority
                service.updateTaskDetails(task.id, newTitle, newDesc, finalDod, newPriority)
                close(OK_EXIT_CODE)
            }
        })

        if (task.status == "AWAITING_APPROVAL") {
            actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.approve")) {
                override fun doAction(e: java.awt.event.ActionEvent) {
                    service.approveTask(task.id)
                    close(OK_EXIT_CODE)
                }
            })
            actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.reject")) {
                override fun doAction(e: java.awt.event.ActionEvent) {
                    service.rejectTask(task.id, MoeBundle.message("moe.message.rejectedInUI"))
                    close(OK_EXIT_CODE)
                }
            })
        }

        if (task.status == "REVIEW" || task.status == "DONE") {
            actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.reopen")) {
                override fun doAction(e: java.awt.event.ActionEvent) {
                    service.reopenTask(task.id, MoeBundle.message("moe.message.reopenedInUI"))
                    close(OK_EXIT_CODE)
                }
            })
        }

        actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.delete")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val result = Messages.showYesNoDialog(
                    project,
                    MoeBundle.message("moe.message.deleteTask", task.title),
                    MoeBundle.message("moe.message.deleteTaskTitle"),
                    Messages.getWarningIcon()
                )
                if (result == Messages.YES) {
                    service.deleteTask(task.id)
                    close(OK_EXIT_CODE)
                }
            }
        })

        actions.add(cancelAction)
        return actions.toTypedArray()
    }
}

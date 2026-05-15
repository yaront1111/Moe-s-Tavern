package com.moe.toolwindow

import com.moe.model.MoeState
import com.moe.model.Task
import com.moe.model.ImplementationStep
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.util.MoeBundle
import com.moe.util.MoeDuration
import com.intellij.openapi.project.Project
import java.time.Instant
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
    private val service: MoeProjectService,
    private val onNext: ((Task) -> Unit)? = null,
    private val onPrevious: ((Task) -> Unit)? = null
) : DialogWrapper(project) {

    private val titleField = JBTextField(task.title)
    private val priorityCombo = ComboBox(arrayOf("CRITICAL", "HIGH", "MEDIUM", "LOW"))
    private val descriptionField = JBTextArea(task.description)
    private val dodField = JBTextArea(task.definitionOfDone.joinToString("\n"))
    private val reopenReasonField = JBTextArea(task.reopenReason ?: "")
    private var planScrollPane: JScrollPane? = null
    private var planContainer: JPanel? = null
    private var stateListener: MoeStateListener? = null

    init {
        title = MoeBundle.message("moe.dialog.taskDetail", task.title)
        init()
        // Subscribe to live state updates for step progress
        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {
                val updated = state.tasks.find { it.id == task.id } ?: return
                refreshPlanPanel(updated)
            }
            override fun onStatus(connected: Boolean, message: String) {}
        }
        service.addListener(stateListener!!)
    }

    override fun dispose() {
        stateListener?.let { service.removeListener(it) }
        stateListener = null
        super.dispose()
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

        // Implementation Plan section (live-updated via state listener)
        val planWrapper = JPanel(BorderLayout())
        planWrapper.isOpaque = false
        planContainer = planWrapper
        if (task.implementationPlan.isNotEmpty()) {
            val planPanel = buildPlanPanel(task)
            val planScroll = JScrollPane(planPanel)
            planScroll.preferredSize = Dimension(520, 160)
            planScroll.border = JBUI.Borders.empty()
            planScrollPane = planScroll
            planWrapper.add(planScroll, BorderLayout.CENTER)
        }
        panel.add(planWrapper)

        task.prLink?.let { panel.add(JBLabel(MoeBundle.message("moe.message.prLink", it))) }

        if (task.status == "REVIEW" || task.status == "DONE") {
            panel.add(JBLabel(MoeBundle.message("moe.label.reopenReason")))
            reopenReasonField.lineWrap = true
            reopenReasonField.wrapStyleWord = true
            val reopenScroll = JScrollPane(reopenReasonField)
            reopenScroll.preferredSize = Dimension(520, 100)
            panel.add(reopenScroll)
        } else if (!task.reopenReason.isNullOrBlank()) {
            panel.add(JBLabel(MoeBundle.message("moe.label.reopenReason")))
            val readOnlyArea = JBTextArea(task.reopenReason).apply {
                lineWrap = true
                wrapStyleWord = true
                isEditable = false
            }
            val reopenScroll = JScrollPane(readOnlyArea)
            reopenScroll.preferredSize = Dimension(520, 80)
            panel.add(reopenScroll)
        }

        // Metrics / Budget / Handoffs / Critique section
        val metricsSection = buildMetricsSection()
        if (metricsSection != null) {
            panel.add(metricsSection)
        }

        // Comments section
        val comments = task.comments ?: emptyList()
        panel.add(JBLabel(MoeBundle.message("moe.label.comments")).apply {
            border = JBUI.Borders.emptyTop(8)
        })

        val commentsPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
        }

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
                val header = JBLabel("${comment.author} - ${comment.timestamp.take(19)}").apply {
                    foreground = JBColor.GRAY
                    font = JBUI.Fonts.smallFont()
                }
                val body = JBLabel("<html>${comment.content.replace("\n", "<br>")}</html>")
                commentRow.add(header, BorderLayout.NORTH)
                commentRow.add(body, BorderLayout.CENTER)
                commentsPanel.add(commentRow)
            }
        }

        val commentsScroll = JScrollPane(commentsPanel)
        commentsScroll.preferredSize = Dimension(520, 120)
        commentsScroll.border = JBUI.Borders.empty()
        panel.add(commentsScroll)

        // Ask question input
        val askPanel = JPanel(BorderLayout()).apply { isOpaque = false }
        val questionField = JBTextField().apply {
            toolTipText = MoeBundle.message("moe.message.typeQuestion")
        }
        val askButton = javax.swing.JButton(MoeBundle.message("moe.button.askQuestion"))
        askButton.addActionListener {
            val text = questionField.text.trim()
            if (text.isNotEmpty()) {
                service.addTaskComment(task.id, text)
                questionField.text = ""
            }
        }
        askPanel.add(questionField, BorderLayout.CENTER)
        askPanel.add(askButton, BorderLayout.EAST)
        panel.add(askPanel)

        return panel
    }

    private fun buildPlanPanel(t: Task): JPanel {
        return JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = BorderFactory.createTitledBorder(
                JBUI.Borders.customLine(JBColor.border()),
                MoeBundle.message("moe.label.implementationPlan")
            )
            for ((index, step) in t.implementationPlan.withIndex()) {
                add(createStepRow(index + 1, step))
            }
        }
    }

    private fun refreshPlanPanel(updated: Task) {
        val container = planContainer ?: return
        javax.swing.SwingUtilities.invokeLater {
            container.removeAll()
            if (updated.implementationPlan.isNotEmpty()) {
                val newPlan = buildPlanPanel(updated)
                val newScroll = JScrollPane(newPlan)
                newScroll.preferredSize = Dimension(520, 160)
                newScroll.border = JBUI.Borders.empty()
                planScrollPane = newScroll
                container.add(newScroll, BorderLayout.CENTER)
            }
            container.revalidate()
            container.repaint()
        }
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

    private fun buildMetricsSection(): JComponent? {
        val metrics = task.metrics
        val budget = task.budget
        val handoffs = task.priorHandoffs.orEmpty()
        val failedDod = task.failedDodItems.orEmpty()
        val critique = task.planCritiqueResult

        // Nothing to render? Return null to avoid empty sections.
        if (metrics == null && budget == null && handoffs.isEmpty() && failedDod.isEmpty() && critique == null) {
            return null
        }

        val container = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            border = BorderFactory.createTitledBorder(
                JBUI.Borders.customLine(JBColor.border()),
                MoeBundle.message("moe.label.metrics")
            )
        }

        // Headline KPI rows
        val kpis = JPanel(FlowLayout(FlowLayout.LEFT, 12, 2)).apply { isOpaque = false }
        val planned = metrics?.plannedStepCount
        val executed = metrics?.executedStepCount
        if (planned != null || executed != null) {
            kpis.add(kpiLabel(MoeBundle.message("moe.metrics.steps"), "${executed ?: "-"} / ${planned ?: "-"}"))
        }
        metrics?.wallClockMs?.let {
            kpis.add(kpiLabel(MoeBundle.message("moe.metrics.wallClock"), MoeDuration.humanise(it)))
        } ?: run {
            // Derive from firstClaimAt if metrics.wallClockMs is unset
            val first = MoeDuration.parseInstant(metrics?.firstClaimAt)
            val done = MoeDuration.parseInstant(metrics?.doneAt)
            if (first != null) {
                val derived = MoeDuration.elapsedMs(first, done ?: Instant.now())
                if (derived != null) {
                    kpis.add(kpiLabel(MoeBundle.message("moe.metrics.wallClock"), MoeDuration.humanise(derived)))
                }
            }
        }
        (metrics?.reopenCount ?: task.reopenCount).let { reopenCount ->
            if (reopenCount > 0 || metrics?.reopenCount != null) {
                kpis.add(kpiLabel(MoeBundle.message("moe.metrics.reopen"), reopenCount.toString()))
            }
        }
        metrics?.rejectCount?.let {
            kpis.add(kpiLabel(MoeBundle.message("moe.metrics.reject"), it.toString()))
        }
        budget?.wallClockMs?.let { cap ->
            val first = MoeDuration.parseInstant(metrics?.firstClaimAt)
            val done = MoeDuration.parseInstant(metrics?.doneAt)
            val used = metrics?.wallClockMs ?: MoeDuration.elapsedMs(first, done ?: Instant.now()) ?: 0L
            val remaining = (cap - used).coerceAtLeast(0L)
            kpis.add(kpiLabel(MoeBundle.message("moe.metrics.budgetRemaining"),
                MoeDuration.humanise(remaining) + " / " + MoeDuration.humanise(cap)))
        }
        container.add(kpis)

        // Critique panel
        if (critique != null) {
            val isBlock = critique.verdict == "block"
            val panelBg = if (isBlock) {
                JBColor(Color(0xFEE2E2), Color(0x321C1C))
            } else {
                JBColor(Color(0xDCFCE7), Color(0x1F2D1F))
            }
            val critiquePanel = JPanel(BorderLayout()).apply {
                isOpaque = true
                background = panelBg
                border = JBUI.Borders.empty(6, 8)
            }
            val verdictText = MoeBundle.message("moe.metrics.critiquePrefix") + " " + critique.verdict.uppercase()
            val header = JBLabel(verdictText).apply {
                font = font.deriveFont(Font.BOLD)
            }
            critiquePanel.add(header, BorderLayout.NORTH)
            val concerns = critique.concerns
            if (!concerns.isNullOrEmpty()) {
                val list = JBTextArea(concerns.joinToString("\n") { "• $it" }).apply {
                    isEditable = false
                    lineWrap = true
                    wrapStyleWord = true
                    isOpaque = false
                }
                critiquePanel.add(list, BorderLayout.CENTER)
            }
            if (!critique.reviewedBy.isNullOrBlank() || !critique.reviewedAt.isNullOrBlank()) {
                val by = critique.reviewedBy ?: "unknown"
                val at = critique.reviewedAt ?: ""
                critiquePanel.add(JBLabel("$by  $at").apply {
                    foreground = JBColor.GRAY
                    font = JBUI.Fonts.smallFont()
                }, BorderLayout.SOUTH)
            }
            container.add(critiquePanel)
        }

        // Failed DoD list
        if (failedDod.isNotEmpty()) {
            // Group by item to surface per-item failure counts
            val grouped = failedDod.groupingBy { it.item }.eachCount()
            val text = grouped.entries.joinToString("\n") { (item, count) ->
                if (count > 1) "• $item  ($count failures)" else "• $item"
            }
            val section = JPanel(BorderLayout()).apply {
                isOpaque = false
                border = JBUI.Borders.emptyTop(6)
            }
            section.add(JBLabel(MoeBundle.message("moe.metrics.failedDod")).apply {
                font = font.deriveFont(Font.BOLD)
            }, BorderLayout.NORTH)
            val area = JBTextArea(text).apply {
                isEditable = false
                lineWrap = true
                wrapStyleWord = true
            }
            val scroll = JScrollPane(area)
            scroll.preferredSize = Dimension(520, 80)
            section.add(scroll, BorderLayout.CENTER)
            container.add(section)
        }

        // Prior handoffs (collapsible-style: render with titled border per handoff)
        if (handoffs.isNotEmpty()) {
            val section = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                isOpaque = false
                border = JBUI.Borders.emptyTop(6)
            }
            section.add(JBLabel(MoeBundle.message("moe.metrics.handoffs", handoffs.size)).apply {
                font = font.deriveFont(Font.BOLD)
            })
            for ((i, h) in handoffs.withIndex()) {
                val header = buildString {
                    append("#").append(i + 1)
                    if (!h.from.isNullOrBlank()) append(" from ").append(h.from)
                    if (!h.to.isNullOrBlank()) append(" → ").append(h.to)
                    if (!h.createdAt.isNullOrBlank()) append("  (").append(h.createdAt).append(")")
                }
                val sub = JPanel().apply {
                    layout = BoxLayout(this, BoxLayout.Y_AXIS)
                    isOpaque = false
                    border = BorderFactory.createTitledBorder(
                        JBUI.Borders.customLine(JBColor.border()),
                        header
                    )
                }
                sub.add(handoffBlock(MoeBundle.message("moe.metrics.handoff.whatIsDone"), h.whatIsDone))
                sub.add(handoffBlock(MoeBundle.message("moe.metrics.handoff.whatRemains"), h.whatRemains))
                sub.add(handoffBlock(MoeBundle.message("moe.metrics.handoff.pitfalls"), h.pitfalls))
                sub.add(handoffBlock(MoeBundle.message("moe.metrics.handoff.openQuestions"), h.openQuestions))
                section.add(sub)
            }
            val sectionScroll = JScrollPane(section)
            sectionScroll.preferredSize = Dimension(520, 200)
            sectionScroll.border = JBUI.Borders.empty()
            container.add(sectionScroll)
        }

        return container
    }

    private fun kpiLabel(label: String, value: String): JComponent {
        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
        }
        panel.add(JBLabel(label).apply {
            foreground = JBColor.GRAY
            font = JBUI.Fonts.smallFont()
        })
        panel.add(JBLabel(value).apply {
            font = font.deriveFont(Font.BOLD)
        })
        return panel
    }

    private fun handoffBlock(label: String, value: String?): JComponent {
        val row = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(2, 4)
        }
        val header = JBLabel(label).apply {
            foreground = JBColor.GRAY
            font = JBUI.Fonts.smallFont().deriveFont(Font.BOLD)
        }
        row.add(header, BorderLayout.NORTH)
        val display = if (value.isNullOrBlank()) "—" else value
        val area = JBTextArea(display).apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            isOpaque = false
        }
        row.add(area, BorderLayout.CENTER)
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
                    val reason = reopenReasonField.text.trim().ifEmpty { MoeBundle.message("moe.message.reopenedInUI") }
                    service.reopenTask(task.id, reason)
                    close(OK_EXIT_CODE)
                }
            })
        }

        if (onPrevious != null) {
            actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.previous")) {
                override fun doAction(e: java.awt.event.ActionEvent) {
                    onPrevious.invoke(task)
                    close(OK_EXIT_CODE)
                }
            })
        }

        if (onNext != null) {
            actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.next")) {
                override fun doAction(e: java.awt.event.ActionEvent) {
                    onNext.invoke(task)
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

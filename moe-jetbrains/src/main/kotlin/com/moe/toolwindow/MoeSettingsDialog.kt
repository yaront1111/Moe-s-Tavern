package com.moe.toolwindow

import com.moe.model.ProjectSettings
import com.moe.services.MoeProjectService
import com.moe.util.MoeBundle
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JSpinner
import javax.swing.SpinnerNumberModel

class MoeSettingsDialog(
    project: Project,
    private val service: MoeProjectService,
    private val currentSettings: ProjectSettings?
) : DialogWrapper(project) {

    private val approvalModeCombo = ComboBox(arrayOf("CONTROL", "SPEED", "TURBO"))
    private val speedModeDelaySpinner = JSpinner(SpinnerNumberModel(2000, 500, 30000, 500))
    private val agentCommandCombo = ComboBox(arrayOf("claude", "codex", "gemini")).apply {
        isEditable = true
    }
    private val autoCreateBranchCheckbox = JBCheckBox(MoeBundle.message("moe.settings.autoCreateBranch"))
    private val branchPatternField = JBTextField()
    private val commitPatternField = JBTextField()

    init {
        title = MoeBundle.message("moe.dialog.settings")

        // Initialize with current settings
        currentSettings?.let { settings ->
            approvalModeCombo.selectedItem = settings.approvalMode
            speedModeDelaySpinner.value = settings.speedModeDelayMs
            agentCommandCombo.selectedItem = settings.agentCommand
            autoCreateBranchCheckbox.isSelected = settings.autoCreateBranch
            branchPatternField.text = settings.branchPattern
            commitPatternField.text = settings.commitPattern
        }

        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(VerticalLayout(8))
        panel.border = JBUI.Borders.empty(8)

        // Approval Mode
        panel.add(JBLabel(MoeBundle.message("moe.label.approvalMode")))
        panel.add(approvalModeCombo)
        panel.add(JBLabel(MoeBundle.message("moe.settings.approvalModeHint")))

        panel.add(createSeparator())

        // Speed Mode Delay
        panel.add(JBLabel(MoeBundle.message("moe.settings.speedModeDelayLabel")))
        speedModeDelaySpinner.preferredSize = Dimension(100, speedModeDelaySpinner.preferredSize.height)
        panel.add(speedModeDelaySpinner)
        panel.add(JBLabel(MoeBundle.message("moe.settings.speedModeDelayHint")))

        panel.add(createSeparator())

        // Agent Command
        panel.add(JBLabel(MoeBundle.message("moe.settings.agentCommandLabel")))
        panel.add(agentCommandCombo)
        panel.add(JBLabel(MoeBundle.message("moe.settings.agentCommandHint")))

        panel.add(createSeparator())

        // Git Settings
        panel.add(JBLabel(MoeBundle.message("moe.label.gitSettings")))
        panel.add(autoCreateBranchCheckbox)

        panel.add(JBLabel(MoeBundle.message("moe.label.branchPattern")))
        branchPatternField.preferredSize = Dimension(300, branchPatternField.preferredSize.height)
        panel.add(branchPatternField)
        panel.add(JBLabel(MoeBundle.message("moe.settings.branchPatternHint")))

        panel.add(JBLabel(MoeBundle.message("moe.label.commitPattern")))
        commitPatternField.preferredSize = Dimension(300, commitPatternField.preferredSize.height)
        panel.add(commitPatternField)
        panel.add(JBLabel(MoeBundle.message("moe.settings.commitPatternHint")))

        return panel
    }

    private fun createSeparator(): JComponent {
        val sep = JPanel()
        sep.preferredSize = Dimension(0, 8)
        return sep
    }

    override fun createActions(): Array<Action> {
        val saveAction = object : DialogWrapperAction(MoeBundle.message("moe.button.save")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val settings = ProjectSettings(
                    approvalMode = approvalModeCombo.selectedItem as String,
                    speedModeDelayMs = speedModeDelaySpinner.value as Int,
                    agentCommand = (agentCommandCombo.selectedItem as? String)?.trim()?.ifEmpty { "claude" } ?: "claude",
                    autoCreateBranch = autoCreateBranchCheckbox.isSelected,
                    branchPattern = branchPatternField.text.trim(),
                    commitPattern = commitPatternField.text.trim()
                )
                service.updateSettings(settings)
                close(OK_EXIT_CODE)
            }
        }
        return arrayOf(saveAction, cancelAction)
    }
}

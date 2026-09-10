package com.moe.toolwindow

import com.moe.model.ProjectSettings
import com.moe.services.MoeProjectService
import com.moe.util.MoeBundle
import com.moe.util.TerminalAgentLauncher
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
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
    // Built-in CLIs come from the launcher's provider enum (minus the Custom
    // placeholder) so the settings combo cannot drift from the Agents menu.
    private val agentCommandCombo = ComboBox(
        TerminalAgentLauncher.AgentProvider.entries
            .filter { it != TerminalAgentLauncher.AgentProvider.CUSTOM }
            .map { it.command }
            .toTypedArray()
    ).apply {
        isEditable = true
    }
    private val enableAgentTeamsCheckbox = JBCheckBox(MoeBundle.message("moe.settings.enableAgentTeams"))

    init {
        title = MoeBundle.message("moe.dialog.settings")

        // Initialize with current settings
        currentSettings?.let { settings ->
            approvalModeCombo.selectedItem = settings.approvalMode
            speedModeDelaySpinner.value = settings.speedModeDelayMs
            agentCommandCombo.selectedItem = settings.agentCommand
            enableAgentTeamsCheckbox.isSelected = settings.enableAgentTeams
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

        // Agent Teams
        panel.add(enableAgentTeamsCheckbox)
        panel.add(JBLabel(MoeBundle.message("moe.settings.enableAgentTeamsHint")))

        panel.add(createSeparator())

        // Landing & gate policy - read-only, this is what actually decides whether a
        // task's bytes reach a branch.
        panel.add(JBLabel(MoeBundle.message("moe.label.landingPolicy")))
        for (row in effectivePolicyRows(currentSettings)) {
            panel.add(JBLabel("<html><b>" + escapeHtml(row.label) + ":</b> " + escapeHtml(row.value) + "</html>"))
            if (row.detail.isNotEmpty()) {
                panel.add(
                    JBLabel("<html><small>" + escapeHtml(row.detail) + "</small></html>").apply {
                        foreground = UIUtil.getContextHelpForeground()
                    }
                )
            }
        }
        panel.add(JBLabel(MoeBundle.message("moe.settings.landingPolicyHint")))

        return panel
    }

    /**
     * Escapes a settings-supplied string for a Swing HTML label. A `consolidationBranch` or
     * `qualityGate` carrying `&`, `<` or `>` would otherwise be swallowed as markup.
     */
    private fun escapeHtml(text: String): String = text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")

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
                    enableAgentTeams = enableAgentTeamsCheckbox.isSelected
                )
                service.updateSettings(settings)
                close(OK_EXIT_CODE)
            }
        }
        return arrayOf(saveAction, cancelAction)
    }

    /**
     * Read-only rendering of the settings that actually decide whether a task's bytes
     * reach a branch. Pure and time-independent so it can be asserted headlessly: the
     * JetBrains `test` task runs on a bare JVM with no IntelliJ Application, so these
     * strings are plain Kotlin and never [MoeBundle] lookups.
     */
    /** One rendered line of the effective landing/gate policy. */
    data class PolicyRow(val label: String, val value: String, val detail: String = "")

    companion object {
        private const val ON = "On"
        private const val OFF = "Off"

        /** Placeholder, never today's date - the wrappers compute the date at landing time. */
        private const val SHARED_DATED_BRANCH = "moe/work-<YYYY-MM-DD>"

        /**
         * The effective policy the daemon and wrappers will apply, in display order.
         *
         * A null [settings] means the board has not received a snapshot yet; falling back
         * to [ProjectSettings] shows the daemon defaults rather than a blank panel.
         */
        fun effectivePolicyRows(settings: ProjectSettings?): List<PolicyRow> {
            val s = settings ?: ProjectSettings()
            return listOf(
                PolicyRow(
                    "Auto-commit",
                    if (s.autoCommit) ON else OFF,
                    if (s.autoCommit) "Every session exit lands this task's attributed paths."
                    else "No completion, checkpoint or rescue commits."
                ),
                PolicyRow(
                    "Checkpoint commits",
                    if (s.checkpointCommits) ON else OFF,
                    if (s.checkpointCommits) "Non-final exits commit as wip(task-<id>): ..."
                    else "No wip(task-<id>) commits; unlanded bytes wait for completion."
                ),
                PolicyRow(
                    "Push checkpoints",
                    if (s.checkpointPush) ON else OFF,
                    if (s.checkpointPush) "Checkpoint commits are pushed to the remote."
                    else "Checkpoints stay local."
                ),
                PolicyRow(
                    "Commit board state",
                    if (s.commitBoardState) ON else OFF,
                    if (s.commitBoardState) "Landing also stages this task's .moe/tasks/<id>.json."
                    else "This task's .moe/tasks/<id>.json is left uncommitted."
                ),
                PolicyRow(
                    "Commit hooks",
                    if (s.commitHooks) "Run on completion commits" else "Skipped (plumbing commits)",
                    if (s.commitHooks) "Completion commits run git hooks; checkpoints stay plumbing."
                    else "Landing writes the commit directly, so no git hook runs."
                ),
                landingBranchRow(s.consolidationBranch),
                PolicyRow(
                    "Quality gate",
                    if (s.qualityGate.isEmpty()) "Disabled (no command configured)" else s.qualityGate,
                    if (s.qualityGate.isEmpty()) "Nothing gates the completion commit."
                    else "Must exit 0 before the completion commit lands."
                ),
                PolicyRow(
                    "Quality gate scope",
                    if (s.qualityGateScope == "everyTask") "Every task" else "Epic-final task only",
                    if (s.qualityGateScope == "everyTask") "The gate runs before every task's completion commit."
                    else "The gate runs only on the last open task of an epic."
                ),
                attributionRow(s.attributionUndeclared),
                PolicyRow(
                    "Plan size limits",
                    "Warn past ${s.taskSizing.warnSteps} steps / ${s.taskSizing.warnDistinctFiles} files, " +
                        "reject past ${s.taskSizing.maxSteps} / ${s.taskSizing.maxDistinctFiles}",
                    "Applied to every submitted plan."
                )
            )
        }

        /**
         * Only a LITERAL consolidationBranch doubles as the wrapper's peel target; a glob is
         * checked at complete_task only, and the wrappers still peel onto the shared dated branch.
         */
        private fun landingBranchRow(consolidationBranch: String): PolicyRow = when {
            consolidationBranch.isEmpty() -> PolicyRow(
                "Landing branch",
                "$SHARED_DATED_BRANCH (shared, default)",
                "No consolidationBranch set; wrappers peel onto the shared dated branch."
            )
            consolidationBranch.contains("*") -> PolicyRow(
                "Landing branch",
                consolidationBranch,
                "Glob checked at complete_task only; wrappers still peel onto $SHARED_DATED_BRANCH."
            )
            else -> PolicyRow(
                "Landing branch",
                consolidationBranch,
                "Peel target and the branch complete_task requires."
            )
        }

        private fun attributionRow(undeclared: String): PolicyRow = when (undeclared) {
            "never" -> PolicyRow(
                "Undeclared-file attribution",
                "Declared files only (never)",
                "A changed file nobody declared is never committed."
            )
            "always" -> PolicyRow(
                "Undeclared-file attribution",
                "Always commit (always)",
                "A changed file nobody declared is committed regardless of live peers."
            )
            else -> PolicyRow(
                "Undeclared-file attribution",
                "Commit when no other worker is live (solo)",
                "With a live peer, undeclared changes are reported unresolved instead."
            )
        }
    }
}

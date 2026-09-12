package com.moe.toolwindow

import com.google.gson.JsonParser
import com.moe.model.ProjectSettings
import com.moe.model.TaskSizingThresholds
import com.moe.toolwindow.MoeSettingsDialog.PolicyRow
import com.moe.util.MoeJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the effective landing + gate policy the settings dialog advertises. The dialog used to
 * present `autoCreateBranch` / `branchPattern` / `commitPattern` as live policy while no wrapper
 * implements branch-per-task landing, so these assertions pin what the wrappers actually do.
 */
class MoeSettingsDialogTest {

    private fun rows(settings: ProjectSettings?): Map<String, PolicyRow> =
        MoeSettingsDialog.effectivePolicyRows(settings).associateBy { it.label }

    private fun value(settings: ProjectSettings?, label: String): String {
        val row = rows(settings)[label] ?: throw AssertionError("no policy row labelled '$label'")
        return row.value
    }

    @Test
    fun `all defaults render the daemon defaults not blanks or false`() {
        val fromNull = MoeSettingsDialog.effectivePolicyRows(null)
        val fromDefaults = MoeSettingsDialog.effectivePolicyRows(ProjectSettings())
        assertEquals(fromDefaults, fromNull)

        assertEquals(10, fromNull.size)
        assertEquals("On", value(null, "Auto-commit"))
        assertEquals("On", value(null, "Checkpoint commits"))
        assertEquals("On", value(null, "Push checkpoints"))
        assertEquals("On", value(null, "Commit board state"))
        assertEquals("Skipped (plumbing commits)", value(null, "Commit hooks"))
        assertEquals("moe/work-<YYYY-MM-DD> (shared, default)", value(null, "Landing branch"))
        assertEquals("Disabled (no command configured)", value(null, "Quality gate"))
        assertEquals("Epic-final task only", value(null, "Quality gate scope"))
        assertEquals("Commit when no other worker is live (solo)", value(null, "Undeclared-file attribution"))
        assertEquals("Warn past 8 steps / 5 files, reject past 12 / 10", value(null, "Plan size limits"))

        // A blank value is the failure this task exists to remove: an unset key must show the
        // daemon default, never an empty cell.
        for (row in fromNull) {
            assertFalse("blank value for row '${row.label}'", row.value.isBlank())
            assertFalse("blank label", row.label.isBlank())
        }
    }

    @Test
    fun `populated settings render their configured values`() {
        val settings = ProjectSettings(
            autoCommit = false,
            checkpointCommits = false,
            checkpointPush = false,
            commitBoardState = false,
            commitHooks = true,
            consolidationBranch = "release/train",
            qualityGate = "npm run lint",
            qualityGateScope = "everyTask",
            attributionUndeclared = "never",
            taskSizing = TaskSizingThresholds(
                warnSteps = 3,
                maxSteps = 6,
                warnDistinctFiles = 2,
                maxDistinctFiles = 4
            )
        )

        assertEquals("Off", value(settings, "Auto-commit"))
        assertEquals("Off", value(settings, "Checkpoint commits"))
        assertEquals("Off", value(settings, "Push checkpoints"))
        assertEquals("Off", value(settings, "Commit board state"))
        assertEquals("Run on completion commits", value(settings, "Commit hooks"))
        assertEquals("release/train", value(settings, "Landing branch"))
        assertEquals("npm run lint", value(settings, "Quality gate"))
        assertEquals("Every task", value(settings, "Quality gate scope"))
        assertEquals("Declared files only (never)", value(settings, "Undeclared-file attribution"))
        assertEquals("Warn past 3 steps / 2 files, reject past 6 / 4", value(settings, "Plan size limits"))
    }

    @Test
    fun `always attribution renders its own wording`() {
        assertEquals(
            "Always commit (always)",
            value(ProjectSettings(attributionUndeclared = "always"), "Undeclared-file attribution")
        )
    }

    @Test
    fun `an unset consolidation branch names the shared dated fallback`() {
        val row = rows(ProjectSettings(consolidationBranch = ""))["Landing branch"]!!
        assertEquals("moe/work-<YYYY-MM-DD> (shared, default)", row.value)
        assertTrue(row.detail.contains("shared dated branch"))
    }

    @Test
    fun `a literal consolidation branch is the peel target`() {
        val row = rows(ProjectSettings(consolidationBranch = "moe/wave-0"))["Landing branch"]!!
        assertEquals("moe/wave-0", row.value)
        assertEquals("Peel target and the branch complete_task requires.", row.detail)
    }

    @Test
    fun `a glob consolidation branch is check-only`() {
        val row = rows(ProjectSettings(consolidationBranch = "moe/work-*"))["Landing branch"]!!
        assertEquals("moe/work-*", row.value)
        // The glob never becomes the peel target; saying otherwise would repeat the lie this
        // task removes.
        assertTrue(row.detail.contains("complete_task only"))
        assertTrue(row.detail.contains("moe/work-<YYYY-MM-DD>"))
    }

    @Test
    fun `no row presents the retired branch or commit pattern settings`() {
        val rendered = MoeSettingsDialog.effectivePolicyRows(ProjectSettings())
            .joinToString(" ") { "${it.label} ${it.value} ${it.detail}" }
        val retired = listOf(
            "branchPattern",
            "commitPattern",
            "Branch Pattern",
            "Commit Pattern",
            "{epicId}",
            "{taskId}",
            "{taskTitle}",
            "Auto-create git branches"
        )
        for (dead in retired) {
            assertFalse("policy rows still mention '$dead'", rendered.contains(dead))
        }
    }

    @Test
    fun `a project json with no settings block still renders the daemon defaults`() {
        // End-to-end across the real parse path: absent keys must reach the dialog as the
        // daemon's effective values, not as blanks or false.
        val state = MoeJson.parseState(
            JsonParser.parseString(
                """
                {
                  "project": { "id": "proj-1", "name": "Moe", "rootPath": "D:/work/moe" },
                  "epics": [],
                  "tasks": []
                }
                """.trimIndent()
            ).asJsonObject
        )

        assertEquals(
            MoeSettingsDialog.effectivePolicyRows(ProjectSettings()),
            MoeSettingsDialog.effectivePolicyRows(state.project.settings)
        )
        assertEquals("On", value(state.project.settings, "Auto-commit"))
        assertEquals("Skipped (plumbing commits)", value(state.project.settings, "Commit hooks"))
        assertEquals("moe/work-<YYYY-MM-DD> (shared, default)", value(state.project.settings, "Landing branch"))
        assertEquals("Warn past 8 steps / 5 files, reject past 12 / 10", value(state.project.settings, "Plan size limits"))
    }
}

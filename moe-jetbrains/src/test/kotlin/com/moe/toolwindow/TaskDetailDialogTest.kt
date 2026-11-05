package com.moe.toolwindow

import com.google.gson.JsonParser
import com.moe.model.Task
import com.moe.util.MoeJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Comments render as text (J3). The board's 3 s republish stays (see MoeProjectService.startAutoRefresh), but an
 * unchanged board rebuilds no detail-dialog section, epic filter model or proposal card (J8).
 */
class TaskDetailDialogTest {
    private companion object {
        const val PLAN_PENDING = "\"implementationPlan\":[{\"stepId\":\"step-1\",\"description\":\"Edit\",\"status\":\"PENDING\"}]"
        const val PLAN_DONE = "\"implementationPlan\":[{\"stepId\":\"step-1\",\"description\":\"Edit\",\"status\":\"COMPLETED\"}]"
    }

    private fun source(relative: String): String {
        val path = "src/main/kotlin/com/moe/$relative"
        val file = listOf(File(path), File("moe-jetbrains/$path")).firstOrNull { it.isFile }
            ?: throw IllegalStateException("Source not found: $path")
        return file.readText().replace("\r\n", "\n")
    }

    /** Build a task from raw JSON; [fields] are extra `"key":value` pairs. */
    private fun task(status: String, vararg fields: String): Task {
        val json = (listOf(
            "\"id\":\"task-abc1\"",
            "\"epicId\":\"epic-1\"",
            "\"title\":\"A task\"",
            "\"description\":\"\"",
            "\"status\":\"$status\"",
            "\"order\":1.0",
            "\"definitionOfDone\":[]"
        ) + fields).joinToString(",", "{", "}")
        return MoeJson.parseTask(JsonParser.parseString(json).asJsonObject)
    }

    @Test
    fun `a comment is escaped, so its markup reads literally and no tag is fetched`() {
        assertEquals("<html>List&lt;String&gt; &amp; Map</html>", TaskDetailDialog.commentHtml("List<String> & Map"))
        assertEquals(
            "<html>&lt;img src=&quot;http://example.invalid/a.png&quot;&gt;</html>",
            TaskDetailDialog.commentHtml("<img src=\"http://example.invalid/a.png\">")
        )
        assertEquals("<html>&lt;/html&gt;&lt;b&gt;bold</html>", TaskDetailDialog.commentHtml("</html><b>bold"))
        assertEquals("an entity reads as typed", "<html>&amp;lt;b&amp;gt;</html>", TaskDetailDialog.commentHtml("&lt;b&gt;"))
    }

    @Test
    fun `a comment keeps its line breaks`() {
        assertEquals("<html>line one<br>line two</html>", TaskDetailDialog.commentHtml("line one\nline two"))
    }

    @Test
    fun `both dialogs render comments through commentHtml`() {
        for (dialog in listOf("toolwindow/TaskDetailDialog.kt", "toolwindow/PlanReviewDialog.kt")) {
            val src = source(dialog)
            assertFalse("$dialog renders a raw comment", src.contains("\"<html>\${comment.content"))
            assertTrue("$dialog must escape comments", src.contains("commentHtml(comment.content)"))
        }
    }

    @Test
    fun `an unchanged task leaves every live section as rendered`() {
        val fields = arrayOf(PLAN_PENDING, "\"blockedReason\":\"waiting\"", "\"delivery\":{\"attemptPhase\":\"open\"}")
        assertEquals(TaskDetailDialog.liveSections(task("BLOCKED", *fields)), TaskDetailDialog.liveSections(task("BLOCKED", *fields)))
        val commented = task("BLOCKED", *fields, "\"comments\":[{\"id\":\"c1\",\"author\":\"qa\",\"content\":\"new\",\"timestamp\":\"2026-11-05T10:00:00Z\"}]")
        assertEquals(
            "a change no live section shows rebuilds none",
            TaskDetailDialog.liveSections(task("BLOCKED", *fields)), TaskDetailDialog.liveSections(commented)
        )
    }

    @Test
    fun `each live section changes only with its own part of the task`() {
        val base = TaskDetailDialog.liveSections(task("WORKING", PLAN_PENDING))
        assertNull(base.blocker)
        assertNull(base.delivery)

        val stepDone = TaskDetailDialog.liveSections(task("WORKING", PLAN_DONE))
        assertNotEquals(base.plan, stepDone.plan)
        assertEquals(base.blocker, stepDone.blocker)
        assertEquals(base.delivery, stepDone.delivery)

        val blocked = TaskDetailDialog.liveSections(task("BLOCKED", PLAN_PENDING, "\"blockedReason\":\"waiting on staging\""))
        assertEquals(base.plan, blocked.plan)
        assertNotNull(blocked.blocker)
        assertEquals(base.delivery, blocked.delivery)

        val delivering = TaskDetailDialog.liveSections(task("WORKING", PLAN_PENDING, "\"delivery\":{\"attemptPhase\":\"finalizing\"}"))
        assertEquals(base.plan, delivering.plan)
        assertEquals(base.blocker, delivering.blocker)
        assertNotNull(delivering.delivery)
    }

    @Test
    fun `the dialog's state listener rebuilds only a section that changed`() {
        val src = source("toolwindow/TaskDetailDialog.kt")
        val start = "override fun onState(state: MoeState)"
        assertTrue("onState delimiter must exist", src.contains(start))
        val onState = src.substringAfter(start).substringBefore("override fun onStatus(")
        assertTrue(onState.contains("if (sections.plan != rendered.plan) safeRefresh(\"plan panel\")"))
        assertTrue(onState.contains("if (sections.blocker != rendered.blocker) safeRefresh(\"blocker section\")"))
        assertTrue(onState.contains("if (sections.delivery != rendered.delivery) safeRefresh(\"delivery section\")"))
        assertEquals("every refresh is gated", 3, Regex("safeRefresh\\(").findAll(onState).count())
    }

    @Test
    fun `an unchanged epic list keeps the epic filter's model and selection`() {
        val src = source("toolwindow/MoeToolWindowPanel.kt")
        val start = "private fun updateEpicFilter("
        assertTrue("updateEpicFilter delimiter must exist", src.contains(start))
        val update = src.substringAfter(start).substringBefore("private fun reloadProjectSelector(")
        val guard = update.indexOf("if (items == epicFilterItems) return")
        assertTrue("updateEpicFilter must skip unchanged items", guard >= 0)
        assertTrue(guard < update.indexOf("epicFilter.model ="))
        assertTrue(guard < update.indexOf("updatingEpicFilter = true"))
    }

    @Test
    fun `unchanged pending proposals keep their cards`() {
        val src = source("toolwindow/ProposalPanel.kt")
        val start = "override fun onState(state: MoeState)"
        assertTrue("onState delimiter must exist", src.contains(start))
        val onState = src.substringAfter(start).substringBefore("updateList()")
        assertTrue(onState.contains("if (listRendered && pending == proposals) return"))
    }
}
